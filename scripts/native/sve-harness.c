/*
 * Native behaviour harness for the SVE cases of the AArch64 oracle (scripts/native-golden.mjs). This CPU
 * runs SVE only in streaming mode, so each generated case function (sve-cases.s) enters it (smstart sm),
 * loads FPCR, FPSR, p0-p15, z0-z31, NZCV and x0-x30 from a State, runs one instruction, stores them back
 * and leaves streaming mode. Instructions that streaming mode forbids raise SIGILL; the handler leaves
 * streaming mode before anything else runs.
 *
 * Input: the file named by argv[1]: a header (case count, vector length in bytes, buffer size; 32 bits
 * each, then 4 zero bytes), then per case x0-x30 (pointer registers as buffer offsets), the pointer mask
 * and NZCV (32 bits each), FPCR (64 bits), the predicates (vl / 8 bytes each), the Z registers (vl bytes
 * each) and the buffer. With no argument it prints the streaming vector length in bytes.
 *
 * Output, one line per case: index, signal (0 if none), NZCV, x0..x30 in hex (registers near the buffer as
 * p<offset>), the buffer in hex, FPSR in hex, then z0..z31 and p0..p15 in hex, most significant byte first.
 */
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uint64_t x[31];
  uint64_t nzcv;       /* offset 248 */
  uint64_t fpcr;       /* 256 */
  uint64_t fpsr;       /* 264 */
  uint8_t p[16 * 32];  /* 272: p0-p15, vl / 8 bytes each, packed */
  uint8_t z[32 * 256]; /* 784: z0-z31, vl bytes each, packed */
} State;

typedef void (*CaseFn)(State *);

#include "sve-cases.h"

#define NEAR 0x10000

extern uint64_t streaming_vl(void) __asm__("_streaming_vl");

static sigjmp_buf jump;
static volatile sig_atomic_t caught;

static void on_signal(int sig, siginfo_t *info, void *ctx) {
  (void)info;
  (void)ctx;
  __asm__ volatile("smstop sm");
  caught = sig;
  siglongjmp(jump, 1);
}

static void hex(const uint8_t *b, int n) {
  printf(" ");
  for (int i = n - 1; i >= 0; i--) printf("%02x", b[i]);
}

int main(int argc, char **argv) {
  uint64_t svl = streaming_vl();
  if (argc < 2) {
    printf("%llu\n", (unsigned long long)svl);
    return 0;
  }
  FILE *in_file = fopen(argv[1], "rb");
  uint32_t head[4];
  if (!in_file || fread(head, 4, 4, in_file) != 4) return 1;
  uint32_t count = head[0], vl = head[1], size = head[2];
  if (vl != svl || count != CASE_COUNT) {
    fprintf(stderr, "streaming vector length %llu, cases made for %u; %u cases, %d compiled\n", (unsigned long long)svl, vl, count, CASE_COUNT);
    return 1;
  }
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = on_signal;
  sa.sa_flags = SA_SIGINFO | SA_NODEFER;
  sigaction(SIGILL, &sa, NULL);
  sigaction(SIGBUS, &sa, NULL);
  sigaction(SIGSEGV, &sa, NULL);
  sigaction(SIGTRAP, &sa, NULL);
  uint8_t *buf, *mem;
  if (posix_memalign((void **)&buf, 4096, size + 4096) || !(mem = malloc(size))) return 1;
  // A page fault taken in streaming mode comes back with FPSR reset to smstart's value (seen on macOS):
  // touch the case code first, and run a case again if it still ends with exactly that value.
  volatile uint8_t sink = 0;
  for (uint32_t i = 0; i < count; i++)
    for (int k = 0; k < 512; k += 64) sink += *(const volatile uint8_t *)((uintptr_t)CASES[i] + k);
  static State in, s;
  for (uint32_t i = 0; i < count; i++) {
    uint32_t meta[2];
    memset(&in, 0, sizeof in);
    if (fread(in.x, 8, 31, in_file) != 31) return 1;
    if (fread(meta, 4, 2, in_file) != 2 || fread(&in.fpcr, 8, 1, in_file) != 1) return 1;
    if (fread(in.p, vl / 8, 16, in_file) != 16 || fread(in.z, vl, 32, in_file) != 32 || fread(mem, 1, size, in_file) != size) return 1;
    for (int n = 0; n < 31; n++)
      if (meta[0] & (1u << n)) in.x[n] += (uint64_t)(uintptr_t)buf;
    in.nzcv = (uint64_t)meta[1] << 28;
    in.fpsr = 0;
    for (int attempt = 0; attempt < 4; attempt++) {
      s = in;
      memcpy(buf, mem, size);
      caught = 0;
      if (sigsetjmp(jump, 1) == 0) CASES[i](&s);
      __asm__ volatile("msr fpcr, xzr");
      if (caught || s.fpsr != 0x0800009f) break;
    }
    printf("%u %d %d", i, (int)caught, (int)((s.nzcv >> 28) & 15));
    for (int n = 0; n < 31; n++) {
      uint64_t v = s.x[n];
      int64_t off = (int64_t)(v - (uint64_t)(uintptr_t)buf);
      if (off >= -NEAR && off <= NEAR) printf(" p%lld", (long long)off);
      else printf(" %llx", (unsigned long long)v);
    }
    printf(" ");
    for (uint32_t b = 0; b < size; b++) printf("%02x", buf[b]);
    printf(" %llx", (unsigned long long)s.fpsr);
    for (int n = 0; n < 32; n++) hex(s.z + n * vl, vl);
    for (int n = 0; n < 16; n++) hex(s.p + n * (vl / 8), vl / 8);
    printf("\n");
  }
  return 0;
}
