/*
 * Native behaviour harness for the AArch64 oracle (scripts/native-golden.mjs). Each generated case
 * function (cases.s) loads x0-x30, NZCV, FPCR, FPSR and v0-v31 from a State, runs one instruction, and
 * stores them back. The inputs come from inputs.h; faults are caught and reported as the signal number.
 *
 * Output, one line per case: index, signal (0 if none), NZCV, x0..x30 in hex, the 256-byte buffer in hex,
 * FPSR in hex, then v0..v31 as 32 hex digits each (most significant first).
 */
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uint64_t x[31];
  uint64_t nzcv; /* offset 248 */
  uint64_t fpcr; /* 256 */
  uint64_t fpsr; /* 264 */
  uint64_t v[32][2]; /* 272: low doubleword first */
} State;

typedef void (*CaseFn)(State *);

#include "inputs.h"

/** How far from the buffer a register still counts as a pointer into it. */
#define NEAR 0x10000

static sigjmp_buf jump;
static volatile sig_atomic_t caught;

static void on_signal(int sig, siginfo_t *info, void *ctx) {
  (void)info;
  (void)ctx;
  caught = sig;
  siglongjmp(jump, 1);
}

int main(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = on_signal;
  sa.sa_flags = SA_SIGINFO | SA_NODEFER;
  sigaction(SIGILL, &sa, NULL);
  sigaction(SIGBUS, &sa, NULL);
  sigaction(SIGSEGV, &sa, NULL);
  sigaction(SIGTRAP, &sa, NULL);
  uint8_t *buf;
  if (posix_memalign((void **)&buf, 4096, 4096)) return 1;
  for (int i = 0; i < CASE_COUNT; i++) {
    State s;
    memcpy(s.x, INPUT_X[i], sizeof s.x);
    for (int n = 0; n < 31; n++)
      if (INPUT_PTR[i] & (1u << n)) s.x[n] += (uint64_t)(uintptr_t)buf;
    s.nzcv = (uint64_t)INPUT_NZCV[i] << 28;
    s.fpcr = INPUT_FPCR[i];
    s.fpsr = 0;
    memcpy(s.v, INPUT_V[i], sizeof s.v);
    memcpy(buf, INPUT_MEM[i], BUF_BYTES);
    caught = 0;
    if (sigsetjmp(jump, 1) == 0) CASES[i](&s);
    __asm__ volatile("msr fpcr, xzr");
    printf("%d %d %d", i, (int)caught, (int)((s.nzcv >> 28) & 15));
    for (int n = 0; n < 31; n++) {
      uint64_t v = s.x[n];
      // Near the buffer (writeback can move a base past either end): an offset, the same on any machine.
      int64_t off = (int64_t)(v - (uint64_t)(uintptr_t)buf);
      if (off >= -NEAR && off <= NEAR) printf(" p%lld", (long long)off);
      else printf(" %llx", (unsigned long long)v);
    }
    printf(" ");
    for (int b = 0; b < BUF_BYTES; b++) printf("%02x", buf[b]);
    printf(" %llx", (unsigned long long)s.fpsr);
    for (int n = 0; n < 32; n++) printf(" %016llx%016llx", (unsigned long long)s.v[n][1], (unsigned long long)s.v[n][0]);
    printf("\n");
  }
  return 0;
}
