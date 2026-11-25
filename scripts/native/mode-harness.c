/*
 * Streaming-mode probe for the AArch64 oracle (scripts/native-golden.mjs): runs one instruction word per
 * generated case function (mode-cases.s) in each of the four SVCR states (0 neither, 1 SM, 2 ZA, 3 both)
 * and reports whether it raised SIGILL. Each case enters the state, points sp at a scratch stack, zeroes the
 * general registers (so loads and stores fault at address 0 instead of hitting the harness), runs the word,
 * restores sp and leaves the state; any fault leaves through the handler, which runs on its own stack.
 *
 * Output, one line per case: index, then the signal number (0 if none) for states 0 to 3.
 */
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void (*CaseFn)(uint64_t mode);

#include "mode-cases.h"

static sigjmp_buf jump;
static volatile sig_atomic_t caught;

static void on_signal(int sig, siginfo_t *info, void *ctx) {
  (void)info;
  (void)ctx;
  __asm__ volatile("smstop");
  caught = sig;
  siglongjmp(jump, 1);
}

int main(void) {
  stack_t alt;
  alt.ss_sp = malloc(1 << 16);
  alt.ss_size = 1 << 16;
  alt.ss_flags = 0;
  sigaltstack(&alt, NULL);
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = on_signal;
  sa.sa_flags = SA_SIGINFO | SA_NODEFER | SA_ONSTACK;
  sigaction(SIGILL, &sa, NULL);
  sigaction(SIGBUS, &sa, NULL);
  sigaction(SIGSEGV, &sa, NULL);
  sigaction(SIGTRAP, &sa, NULL);
  sigaction(SIGFPE, &sa, NULL);
  for (int i = 0; i < CASE_COUNT; i++) {
    printf("%d", i);
    for (uint64_t mode = 0; mode < 4; mode++) {
      caught = 0;
      if (sigsetjmp(jump, 1) == 0) CASES[i](mode);
      __asm__ volatile("msr fpcr, xzr");
      printf(" %d", (int)caught);
    }
    printf("\n");
  }
  return 0;
}
