// Hello: printing with Linux system calls
// There is no main: the program starts at _start, like a Linux program without the C library.
// A system call: number in x8, arguments in x0–x5, then svc #0; the result comes back in x0.

.text
.global _start
_start:
    mov     x0, #1                      // argument 1: file descriptor 1, standard output
    adr     x1, msg                     // argument 2: address of the string
    mov     x2, #len                    // argument 3: byte count
    mov     x8, #64                     // system call 64 is write
    svc     #0                          // enter the kernel, which prints the string
    mov     x0, #0                      // exit code 0
    mov     x8, #93                     // system call 93 is exit
    svc     #0                          // the program ends here

.data
msg:    .ascii  "Hello, AArch64!\n"
len = . - msg                           // len is the string's length (. is the current address)
