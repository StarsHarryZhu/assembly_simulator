// 你好：直接用 Linux 系统调用输出
// 没有 main，程序从 _start 开始，像不用 C 库的 Linux 程序。
// 系统调用：号码放 x8，参数放 x0–x5，执行 svc #0，结果回到 x0。

.text
.global _start
_start:
    mov     x0, #1                      // 第 1 个参数：文件描述符 1，标准输出
    adr     x1, msg                     // 第 2 个参数：字符串的地址
    mov     x2, #len                    // 第 3 个参数：字节数
    mov     x8, #64                     // 64 号系统调用是 write
    svc     #0                          // 进入内核，输出字符串
    mov     x0, #0                      // 退出码 0
    mov     x8, #93                     // 93 号系统调用是 exit
    svc     #0                          // 程序到这里结束

.data
msg:    .ascii  "Hello, AArch64!\n"
len = . - msg                           // len 是字符串的字节数（. 是当前地址）
