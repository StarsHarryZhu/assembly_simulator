/**
 * Longer references for instructions a one-line description cannot explain:
 * - `svc #0`: the Linux system calls the simulated kernel answers, by the number in x8 (linux.ts);
 * - `bl`: the built-in C library functions (libc.ts);
 * - the condition codes of B.cond, CSEL, CCMP and the rest;
 * - `mrs`/`msr`: the system registers this machine keeps (registers.ts);
 * - exceptions: the classes in ESR_EL1 and where the vector table entries are (cpu.ts);
 * - every assembler directive (assembler.ts), with an example.
 * Written in our own words from what the engine does; tests check the numbers against the engine.
 */
import { T, type Text } from '../../core/i18n'
import type { RefRegister, RefRow, ReferenceTable } from '../../core/isa'
import { LIBC } from './libc'
import { EC } from './cpu'
import { SYSREGS } from './registers'

const r = (reg: string, zh: string, en: string): RefRegister => ({ reg, text: T(zh, en) })
const row = (key: string, title: Text, text: Text, note?: Text): RefRow => ({ key, title, text, ...(note ? { note } : {}) })
const dir = (key: string, title: Text, text: Text, example: string, note?: Text): RefRow => ({ ...row(key, title, text, note), example })

/* ---------------------------------------------------------------- svc */

const FD = r('x0', '文件描述符：0 标准输入，1 标准输出，2 标准错误，3 起是 openat 打开的文件', 'file descriptor: 0 stdin, 1 stdout, 2 stderr, 3 and up from openat')
const RESULT = r('x0', '结果；出错时是 −errno（负数）', 'the result; −errno (negative) on error')
const sys = (nr: number, name: string, title: Text, args: RefRegister[], results: RefRegister[], note?: Text, example?: string): RefRow => ({
  key: String(nr),
  title: T(`${name} — ${title.zh}`, `${name} — ${title.en}`),
  args,
  results,
  ...(note ? { note } : {}),
  ...(example ? { example } : {}),
})

export const SYSCALLS_TABLE: ReferenceTable = {
  id: 'svc',
  mnemonics: ['svc'],
  title: T('Linux 系统调用', 'Linux system calls'),
  intro: T(
    '程序像 Linux 进程一样运行：把系统调用号放进 x8，参数放进 x0–x5，执行 svc #0，结果回到 x0。出错时 x0 是负的错误码（−errno）。没有列出的号码返回 −38（ENOSYS），并在控制台说明。',
    'Programs run like Linux processes: put the system call number in x8 and the arguments in x0–x5, then svc #0; the result comes back in x0. On error x0 holds a negative error code (−errno). Numbers not listed return −38 (ENOSYS) with a note on the console.',
  ),
  keyTitle: T('x8', 'x8'),
  groups: [
    {
      title: T('输入输出和文件', 'Input, output and files'),
      rows: [
        sys(63, 'read', T('读入', 'read'), [FD, r('x1', '缓冲区地址', 'buffer address'), r('x2', '最多读几个字节', 'most bytes to read')], [r('x0', '读到的字节数（0 表示文件结束）', 'bytes read (0 at end of file)')], T('从标准输入读时，一次最多返回一行（含换行符）；还没有输入就等待。', 'Reading stdin returns at most one line (with its newline), waiting for input when there is none.')),
        sys(64, 'write', T('输出', 'write'), [FD, r('x1', '数据地址', 'data address'), r('x2', '字节数', 'byte count')], [r('x0', '写出的字节数', 'bytes written')], undefined, 'mov x0, #1\nadr x1, msg\nmov x2, #6\nmov x8, #64\nsvc #0'),
        sys(56, 'openat', T('打开文件', 'open a file'), [r('x0', '目录（写 −100，即 AT_FDCWD）', 'directory (use −100, AT_FDCWD)'), r('x1', '文件名的地址（以 0 结尾）', 'address of the file name (ends with 0)'), r('x2', '方式：0 只读，1 只写，2 读写；加 0x40 创建，0x200 清空，0x400 追加', 'flags: 0 read, 1 write, 2 both; add 0x40 create, 0x200 truncate, 0x400 append'), r('x3', '权限（这里不用）', 'mode (unused here)')], [r('x0', '新的文件描述符，或 −2（ENOENT）', 'the new descriptor, or −2 (ENOENT)')], T('文件在“文件”面板里。', 'Files live in the Files panel.')),
        sys(57, 'close', T('关闭文件', 'close a file'), [FD], [RESULT]),
        sys(62, 'lseek', T('移动读写位置', 'move the file position'), [FD, r('x1', '偏移', 'offset'), r('x2', '从哪里算：0 开头，1 当前，2 结尾', 'from: 0 start, 1 current, 2 end')], [r('x0', '新的位置', 'the new position')]),
      ],
    },
    {
      title: T('进程', 'Process'),
      rows: [
        sys(93, 'exit', T('结束程序', 'end the program'), [r('x0', '退出码（低 8 位）', 'exit code (low 8 bits)')], [], undefined, 'mov x0, #0\nmov x8, #93\nsvc #0'),
        sys(94, 'exit_group', T('结束程序', 'end the program'), [r('x0', '退出码（低 8 位）', 'exit code (low 8 bits)')], []),
        sys(172, 'getpid', T('进程号', 'process id'), [], [r('x0', '进程号（这里总是 1000）', 'process id (always 1000 here)')]),
        sys(173, 'getppid', T('父进程号', 'parent process id'), [], [r('x0', '父进程号（1）', 'parent id (1)')]),
        sys(174, 'getuid', T('用户号', 'user id'), [], [r('x0', '用户号（1000）', 'user id (1000)')]),
        sys(178, 'gettid', T('线程号', 'thread id'), [], [r('x0', '线程号（1000）', 'thread id (1000)')]),
      ],
    },
    {
      title: T('内存', 'Memory'),
      rows: [
        sys(214, 'brk', T('调整堆顶', 'move the program break'), [r('x0', '新的堆顶地址；0 表示只查询', 'the new break; 0 only asks')], [r('x0', '当前的堆顶', 'the current break')], T('堆从 0x10000000 开始，最多到 0x20000000。不合理的地址不改变堆顶。', 'The heap starts at 0x10000000 and may grow to 0x20000000. A bad address leaves the break as it is.')),
        sys(222, 'mmap', T('映射内存', 'map memory'), [r('x0', '建议地址（这里不用）', 'address hint (unused here)'), r('x1', '长度', 'length'), r('x2', '权限（这里不用）', 'protection (unused here)'), r('x3', '标志：要包含 0x20（MAP_ANONYMOUS）', 'flags: must include 0x20 (MAP_ANONYMOUS)'), r('x4', '文件描述符（写 −1）', 'descriptor (use −1)'), r('x5', '偏移（写 0）', 'offset (use 0)')], [r('x0', '新内存的地址（清零，按 4 KB 对齐）', 'address of the new memory (zeroed, 4 KB aligned)')], T('只支持匿名映射，从 1 TB（0x10000000000）往上分配。', 'Anonymous mappings only, allocated upwards from 1 TB (0x10000000000).')),
        sys(215, 'munmap', T('取消映射', 'unmap memory'), [r('x0', '地址（按 4 KB 对齐）', 'address (4 KB aligned)'), r('x1', '长度', 'length')], [RESULT]),
      ],
    },
    {
      title: T('时间和随机数', 'Time and randomness'),
      rows: [
        sys(113, 'clock_gettime', T('读时钟', 'read a clock'), [r('x0', '时钟编号（任意）', 'clock id (any)'), r('x1', '结果的地址：秒（8 字节）、纳秒（8 字节）', 'where to store: seconds (8 bytes), nanoseconds (8 bytes)')], [RESULT]),
        sys(101, 'nanosleep', T('暂停', 'sleep'), [r('x0', '时长的地址：秒（8 字节）、纳秒（8 字节）', 'address of the duration: seconds (8 bytes), nanoseconds (8 bytes)'), r('x1', '剩余时间的地址（这里不用）', 'remaining time (unused here)')], [RESULT], T('最多暂停 60 秒。', 'Sleeps 60 seconds at most.')),
        sys(278, 'getrandom', T('随机字节', 'random bytes'), [r('x0', '缓冲区地址', 'buffer address'), r('x1', '字节数', 'byte count'), r('x2', '标志（这里不用）', 'flags (unused here)')], [r('x0', '写入的字节数', 'bytes written')]),
      ],
    },
  ],
}

/* ---------------------------------------------------------------- C library */

export const LIBC_TABLE: ReferenceTable = {
  id: 'libc',
  mnemonics: ['bl'],
  title: T('内置 C 库函数', 'Built-in C library'),
  intro: T(
    '程序调用（bl）这些函数而自己没有定义时，用的是内置的版本，就像动态链接的程序用系统的 C 库一样。参数按 AAPCS64：整数和指针依次放 x0–x7（printf 的可变参数也是），更多的放在栈上；结果在 x0。整个调用算一步，返回到 x30。和真正的 C 库不同，这里的函数不会改动 x0 以外的寄存器。',
    'A program that calls (bl) one of these without defining it gets the built-in one, as a dynamically linked program gets the system\'s C library. Arguments follow AAPCS64: integers and pointers in x0–x7 in order (printf\'s variable arguments too), the rest on the stack; the result in x0. A whole call is one step and returns to x30. Unlike a real C library, these functions change no register but x0.',
  ),
  keyTitle: T('函数', 'Function'),
  groups: [
    {
      rows: LIBC.map((f) => ({
        key: f.name,
        title: T(f.proto, f.proto),
        text: f.desc,
        ...(f.name === 'printf' ? { example: 'adr x0, fmt        // fmt: .asciz "%d\\n"\nmov w1, #42\nbl printf' } : {}),
      })),
    },
  ],
}

/* ---------------------------------------------------------------- conditions */

const cond = (key: string, title: Text, flags: string, after: Text): RefRow => {
  const en = flags.replace(' 且 ', ' and ').replace(' 或 ', ' or ')
  return { key, title, text: T(`${flags}：${after.zh}`, `${en}: ${after.en}`) }
}

export const CONDITIONS: ReferenceTable = {
  id: 'cond',
  mnemonics: ['b.<cond>', 'bc.<cond>', 'csel', 'csinc', 'csinv', 'csneg', 'cset', 'csetm', 'cinc', 'cinv', 'cneg', 'ccmp', 'ccmn'],
  title: T('条件码', 'Condition codes'),
  intro: T(
    '条件看 NZCV 四个标志。比较指令 cmp a, b 算 a − b 并设置标志，之后的条件按下表读作“a 与 b 的关系”。有符号比较用 gt/ge/lt/le，无符号比较用 hi/hs/lo/ls。',
    'Conditions test the four flags NZCV. cmp a, b computes a − b and sets the flags; afterwards each condition reads as a relation between a and b. Use gt/ge/lt/le for signed comparisons and hi/hs/lo/ls for unsigned ones.',
  ),
  keyTitle: T('条件', 'Condition'),
  groups: [
    {
      rows: [
        cond('eq', T('相等', 'equal'), 'Z = 1', T('a = b', 'a = b')),
        cond('ne', T('不相等', 'not equal'), 'Z = 0', T('a ≠ b', 'a ≠ b')),
        cond('hs', T('无符号大于等于（也写 cs）', 'unsigned higher or same (also cs)'), 'C = 1', T('无符号 a ≥ b；加法时表示有进位', 'unsigned a ≥ b; after an add, a carry out')),
        cond('lo', T('无符号小于（也写 cc）', 'unsigned lower (also cc)'), 'C = 0', T('无符号 a < b', 'unsigned a < b')),
        cond('mi', T('负数', 'negative'), 'N = 1', T('结果为负', 'the result is negative')),
        cond('pl', T('非负', 'positive or zero'), 'N = 0', T('结果 ≥ 0', 'the result is ≥ 0')),
        cond('vs', T('有符号溢出', 'overflow'), 'V = 1', T('有符号运算溢出', 'signed overflow')),
        cond('vc', T('没有溢出', 'no overflow'), 'V = 0', T('没有有符号溢出', 'no signed overflow')),
        cond('hi', T('无符号大于', 'unsigned higher'), 'C = 1 且 Z = 0', T('无符号 a > b', 'unsigned a > b')),
        cond('ls', T('无符号小于等于', 'unsigned lower or same'), 'C = 0 或 Z = 1', T('无符号 a ≤ b', 'unsigned a ≤ b')),
        cond('ge', T('有符号大于等于', 'signed greater or equal'), 'N = V', T('有符号 a ≥ b', 'signed a ≥ b')),
        cond('lt', T('有符号小于', 'signed less than'), 'N ≠ V', T('有符号 a < b', 'signed a < b')),
        cond('gt', T('有符号大于', 'signed greater than'), 'Z = 0 且 N = V', T('有符号 a > b', 'signed a > b')),
        cond('le', T('有符号小于等于', 'signed less or equal'), 'Z = 1 或 N ≠ V', T('有符号 a ≤ b', 'signed a ≤ b')),
        cond('al', T('总是', 'always'), '—', T('不看标志', 'ignores the flags')),
        cond('nv', T('总是（保留的写法）', 'always (reserved spelling)'), '—', T('在 A64 里和 al 一样', 'the same as al in A64')),
      ],
    },
    {
      title: T('SVE 的写法（谓词测试之后）', 'SVE names (after a predicate test)'),
      rows: [
        cond('none', T('没有活跃元素为真（同 eq）', 'no active element true (as eq)'), 'Z = 1', T('结果谓词全假', 'the result predicate is all false')),
        cond('any', T('有活跃元素为真（同 ne）', 'some active element true (as ne)'), 'Z = 0', T('至少一个为真', 'at least one is true')),
        cond('first', T('第一个活跃元素为真（同 mi）', 'the first active element true (as mi)'), 'N = 1', T('whilelo 之后：还有元素要处理', 'after whilelo: elements are left to process')),
        cond('nfrst', T('第一个活跃元素为假（同 pl）', 'the first active element false (as pl)'), 'N = 0', T('第一个为假', 'the first is false')),
        cond('last', T('最后一个活跃元素为真（同 lo）', 'the last active element true (as lo)'), 'C = 0', T('最后一个为真', 'the last is true')),
        cond('nlast', T('最后一个活跃元素为假（同 hs）', 'the last active element false (as hs)'), 'C = 1', T('最后一个为假', 'the last is false')),
        cond('pmore', T('还有，且最后一个为假（同 hi）', 'more remain, the last false (as hi)'), 'C = 1 且 Z = 0', T('有为真的元素，最后一个为假', 'some true, the last false')),
        cond('plast', T('没有了，或最后一个为真（同 ls）', 'none, or the last true (as ls)'), 'C = 0 或 Z = 1', T('全假，或最后一个为真', 'all false, or the last true')),
        cond('tcont', T('继续：没找到终止条件（同 ge）', 'continue: no termination found (as ge)'), 'N = V', T('cterm 之后：循环继续', 'after cterm: the loop continues')),
        cond('tstop', T('停止：找到终止条件（同 lt）', 'stop: termination found (as lt)'), 'N ≠ V', T('cterm 之后：循环结束', 'after cterm: the loop ends')),
      ],
    },
  ],
}

/* ---------------------------------------------------------------- system registers */

export const SYSREG_TABLE: ReferenceTable = {
  id: 'sysregs',
  mnemonics: ['mrs', 'msr'],
  title: T('系统寄存器', 'System registers'),
  intro: T(
    'mrs Xt, 寄存器 读系统寄存器，msr 寄存器, Xt 写。带 _EL1 的寄存器只有内核态（EL1，也就是 .ktext 里的异常处理程序）能用，用户态访问是未定义指令（SIGILL）；ID 寄存器例外，Linux 会替用户态模拟读取。没有列出的寄存器可以写成 s3_0_c15_c2_0 这样的编号。',
    'mrs Xt, reg reads a system register and msr reg, Xt writes one. Registers ending in _EL1 are for kernel mode only (EL1: an exception handler in .ktext); at EL0 they are undefined instructions (SIGILL), except the ID registers, whose reads Linux emulates. Other registers can be written by number, as s3_0_c15_c2_0.',
  ),
  keyTitle: T('寄存器', 'Register'),
  groups: [
    {
      rows: SYSREGS.map((d) => ({
        key: d.name,
        title: T(d.writeEl === null ? `只读，EL${d.readEl} 起` : `读写，EL${d.readEl} 起`, d.writeEl === null ? `read-only, from EL${d.readEl}` : `read-write, from EL${d.readEl}`),
        text: d.note,
      })),
    },
  ],
}

/* ---------------------------------------------------------------- exceptions */

const ec = (code: number, title: Text, text: Text): RefRow => ({ key: `0x${code.toString(16).padStart(2, '0')}`, title, text })

export const EXCEPTIONS: ReferenceTable = {
  id: 'exceptions',
  mnemonics: ['eret', 'brk', 'udf'],
  title: T('异常', 'Exceptions'),
  intro: T(
    '程序有 .ktext 段时，加载器把 VBAR_EL1 设成标签 vectors（没有就用 .ktext 的开头），出错时处理器进入 EL1：ELR_EL1 存出错指令的地址，ESR_EL1 的第 31..26 位是下表的异常类别，FAR_EL1 存出错的数据地址，SPSR_EL1 存原来的标志和级别，然后跳到向量表：从 EL0 来的同步异常在 VBAR + 0x400，在 EL1 里发生的在 VBAR + 0x200。处理完把 ELR_EL1 改到下一条指令（加 4），再 eret。没有 .ktext 时，程序像 Linux 进程收到信号一样停下。svc #0 总是交给模拟的 Linux。',
    'When the program has a .ktext section, the loader sets VBAR_EL1 to the label vectors (or the start of .ktext), and a fault takes the processor to EL1: ELR_EL1 holds the faulting instruction\'s address, bits 31..26 of ESR_EL1 the exception class below, FAR_EL1 the faulting data address, SPSR_EL1 the old flags and level; then it jumps into the vector table: synchronous exceptions from EL0 at VBAR + 0x400, those taken at EL1 at VBAR + 0x200. A handler moves ELR_EL1 on to the next instruction (add 4) and returns with eret. Without .ktext the program stops as a Linux process does on a signal. svc #0 always goes to the simulated Linux.',
  ),
  keyTitle: T('EC', 'EC'),
  groups: [
    {
      rows: [
        ec(EC.unknown, T('未定义指令（SIGILL）', 'Undefined instruction (SIGILL)'), T('udf、hvc、smc，用户态访问内核寄存器或执行 eret，以及不认识的机器字。', 'udf, hvc, smc, kernel registers or eret at EL0, and words that are no instruction.')),
        ec(EC.instrAbortLower, T('取指中止，来自 EL0（SIGSEGV）', 'Instruction abort from EL0 (SIGSEGV)'), T('跳到了没有指令的地方，或用户态跳进了内核代码。', 'A jump to where there is no instruction, or into kernel code from EL0.')),
        ec(EC.instrAbortSame, T('取指中止，在 EL1 里', 'Instruction abort at EL1'), T('同上，发生在内核态。', 'The same, in kernel mode.')),
        ec(EC.pcAlign, T('PC 没对齐（SIGBUS）', 'PC alignment fault (SIGBUS)'), T('跳转目标不是 4 的倍数。FAR_EL1 是那个地址。', 'A branch target that is not a multiple of 4. FAR_EL1 holds it.')),
        ec(EC.dataAbortLower, T('数据中止，来自 EL0（SIGSEGV / SIGBUS）', 'Data abort from EL0 (SIGSEGV / SIGBUS)'), T('读写没有内存的地址、写只读的代码或 .rodata、用户态访问内核地址，或独占、原子访问没对齐。FAR_EL1 是出错的地址；ESR 的第 6 位表示是写。', 'Accessing an address with no memory, writing code or .rodata, touching kernel addresses from EL0, or a misaligned exclusive or atomic access. FAR_EL1 holds the address; ESR bit 6 says it was a write.')),
        ec(EC.dataAbortSame, T('数据中止，在 EL1 里', 'Data abort at EL1'), T('同上，发生在内核态。', 'The same, in kernel mode.')),
        ec(EC.spAlign, T('SP 没对齐（SIGBUS）', 'SP alignment fault (SIGBUS)'), T('用 sp 作基址访存时，sp 不是 16 的倍数。', 'A load or store based on sp while sp is not a multiple of 16.')),
        ec(EC.brk, T('断点（SIGTRAP）', 'Breakpoint (SIGTRAP)'), T('执行了 brk #imm；ESR 的低 16 位是 imm。', 'brk #imm executed; the low 16 bits of ESR hold imm.')),
      ],
    },
  ],
}

/* ---------------------------------------------------------------- directives */

export const DIRECTIVES_TABLE: ReferenceTable = {
  id: 'directives',
  mnemonics: [],
  title: T('伪操作', 'Directives'),
  intro: T(
    '以点开头的词不是指令，不会变成机器码：它们告诉汇编器把东西放在哪个段、怎样放数据。语法和 GNU as 一样：注释用 // 或 /* */（# 只在行首表示注释），一行里可以用 ; 分开几条语句，立即数前的 # 可写可不写。各段依次排在一起：.text 从 0x400000 开始，.rodata、.data、.bss 跟在后面（各自按 4 KB 对齐），所以 adr 能从代码直接取到数据的地址。',
    'Words that start with a dot are not instructions and produce no machine code: they say which section things go in and how data is laid out. The syntax is GNU as: comments are // or /* */ (# only at the start of a line), ; separates statements on one line, and the # before an immediate is optional. Sections follow one another: .text from 0x400000, then .rodata, .data and .bss (each 4 KB aligned), so adr reaches data straight from code.',
  ),
  keyTitle: T('伪操作', 'Directive'),
  groups: [
    {
      title: T('段', 'Sections'),
      rows: [
        dir('.text', T('代码段', 'Code'), T('后面的指令放进代码段（只读、可执行）。', 'What follows goes into the code section (read-only, executable).'), '.text'),
        dir('.data', T('数据段', 'Data'), T('可以读写的数据。', 'Data that may be read and written.'), '.data'),
        dir('.rodata', T('只读数据', 'Read-only data'), T('只读的数据，比如字符串常量；写它会出错（SIGSEGV）。', 'Read-only data such as string constants; writing it faults (SIGSEGV).'), '.section .rodata'),
        dir('.bss', T('清零的数据', 'Zeroed data'), T('只占地方、开始时全是 0 的数据，用 .skip 留空间。', 'Space that starts out as zeros; reserve it with .skip.'), '.bss\nbuf: .skip 64'),
        dir('.section', T('按名字选段', 'Section by name'), T('.text、.data、.rodata、.bss 以及它们带后缀的名字（.data.x），还有内核的 .ktext、.kdata。其他名字按标志放：带 x 的是代码，带 w 的是数据，否则是只读数据。', '.text, .data, .rodata, .bss and names with a suffix (.data.x), and the kernel\'s .ktext and .kdata. Other names go by their flags: x is code, w is data, otherwise read-only data.'), '.section .ktext, "ax"'),
        dir('.pushsection', T('临时换段', 'Switch for a while'), T('.pushsection 换到另一段，.popsection 回到原来的段；.previous 回到上一个段。', '.pushsection switches section, .popsection returns; .previous goes back to the one before.'), '.pushsection .rodata\nmsg: .asciz "hi"\n.popsection'),
      ],
    },
    {
      title: T('数据', 'Data'),
      rows: [
        dir('.byte', T('8 位整数', 'Bytes'), T('每个值占 1 字节。可以写字符，如 \'a\'。', 'One byte per value. Characters like \'a\' work too.'), '.byte 1, 2, \'a\''),
        dir('.hword', T('16 位整数', '16-bit values'), T('每个值占 2 字节，也写作 .short、.2byte。不会自动对齐。', 'Two bytes per value; also .short, .2byte. Not aligned automatically.'), '.hword 0x1234'),
        dir('.word', T('32 位整数', '32-bit values'), T('每个值占 4 字节，也写作 .long、.int、.4byte。不会自动对齐，需要时先写 .balign 4。', 'Four bytes per value; also .long, .int, .4byte. Not aligned automatically: write .balign 4 first when needed.'), '.word 1, -2, 0x30'),
        dir('.quad', T('64 位整数', '64-bit values'), T('每个值占 8 字节，也写作 .xword、.dword、.8byte。写标签就存它的地址。', 'Eight bytes per value; also .xword, .dword, .8byte. A label stores its address.'), '.quad table, 0'),
        dir('.float', T('单精度浮点数', 'Single-precision floats'), T('每个值占 4 字节，也写作 .single。', 'Four bytes per value; also .single.'), '.float 1.5'),
        dir('.double', T('双精度浮点数', 'Double-precision floats'), T('每个值占 8 字节。', 'Eight bytes per value.'), '.double 3.14'),
        dir('.ascii', T('字符串（不加 0）', 'String without a 0'), T('按 UTF-8 存字符，结尾不加 0。支持 \\n \\t \\" \\\\ \\x41 \\101 这样的转义。', 'Characters in UTF-8, no terminating 0. Escapes such as \\n \\t \\" \\\\ \\x41 \\101 work.'), '.ascii "abc"'),
        dir('.asciz', T('字符串（加 0）', 'String with a 0'), T('和 .ascii 一样，但结尾加一个 0 字节，也写作 .string。C 库函数要的就是这种。', 'Like .ascii with a terminating 0 byte; also .string. This is what C library functions expect.'), 'msg: .asciz "Hello\\n"'),
        dir('.skip', T('留空间', 'Reserve space'), T('.skip 字节数[, 填充值]，也写作 .space；.zero 字节数 填 0。', '.skip size[, fill], also .space; .zero size fills with zeros.'), '.skip 100'),
        dir('.fill', T('重复填充', 'Repeat a value'), T('.fill 次数[, 每个大小[, 值]]。', '.fill repeat[, size[, value]].'), '.fill 4, 2, 0xffff'),
        dir('.inst', T('直接写机器字', 'Raw instruction words'), T('把值当作指令放进代码段。', 'Puts values in the code section as instructions.'), '.inst 0xd503201f'),
      ],
    },
    {
      title: T('对齐和位置', 'Alignment and position'),
      rows: [
        dir('.balign', T('按字节数对齐', 'Align to bytes'), T('.balign 字节数[, 填充值[, 最多跳过]]：对齐到 2 的幂字节。代码段里用 nop 填充。', '.balign bytes[, fill[, max]]: align to a power-of-two byte count. Code is padded with nop.'), '.balign 8'),
        dir('.p2align', T('按 2 的幂对齐', 'Align to a power of two'), T('.p2align n 对齐到 2ⁿ 字节；在 AArch64 上 .align n 也是 2ⁿ。', '.p2align n aligns to 2ⁿ bytes; on AArch64 .align n means 2ⁿ too.'), '.p2align 3'),
        dir('.org', T('跳到位置', 'Move forward'), T('把当前位置移到段内的某个偏移（或这一段里的地址），只能往后。', 'Moves the location to an offset in the section (or an address in it); only forwards.'), '.org 0x400'),
        dir('.ltorg', T('放字面量池', 'Place the literal pool'), T('ldr x0, =值 里放不进一条 movz 的值放进字面量池；池子默认在段尾，.ltorg（或 .pool）把它放在这里，用在离段尾超过 1 MB 的代码里。', 'Values of ldr x0, =value that one movz cannot make go into a literal pool, at the end of the section by default; .ltorg (or .pool) places it here, for code more than 1 MB from the end.'), 'ldr x0, =0x123456789\nb 1f\n.ltorg\n1:'),
      ],
    },
    {
      title: T('符号', 'Symbols'),
      rows: [
        dir('.equ', T('定义常量', 'Define a constant'), T('.equ 名字, 值，也写作 .set 或 名字 = 值；.equiv 不允许重复定义。值可以用前面的标签，例如长度 = . − msg。', '.equ name, value, also .set or name = value; .equiv refuses to redefine. The value may use labels, as in len = . − msg.'), 'msg: .ascii "hi\\n"\nlen = . - msg'),
        dir('.global', T('导出符号', 'Export a symbol'), T('.global、.globl、.type、.size、.cfi_* 等这里不起作用，写了也没关系（这样能直接用 gcc 生成的汇编）。', '.global, .globl, .type, .size, .cfi_* and the like have no effect here; they are accepted so gcc output assembles.'), '.global main'),
        dir('_start', T('程序入口', 'Entry point'), T('有 _start 就从那里开始（像裸的 Linux 程序，要自己用 exit 结束）；否则调用 main（argc 在 x0，argv 在 x1），main 返回时用它的返回值结束程序。', 'With _start the program starts there (a bare Linux program, which must call exit); otherwise main is called (argc in x0, argv in x1) and its return value ends the program.'), '.global _start\n_start:'),
      ],
    },
    {
      title: T('宏和条件', 'Macros and conditions'),
      rows: [
        dir('.macro', T('宏', 'Macro'), T('.macro 名字 参数[=默认值]… 到 .endm；里面用 \\参数，\\@ 是展开的序号。参数可以写 :req（必填）或 :vararg（剩下的全部）。', '.macro name param[=default]… up to .endm; use \\param inside, and \\@ for the expansion count. A parameter may be :req or :vararg.'), '.macro push a, b\n    stp \\a, \\b, [sp, #-16]!\n.endm'),
        dir('.rept', T('重复', 'Repeat'), T('.rept 次数 … .endr 把中间的内容重复几次；.irp 符号, 值1, 值2 … .endr 对每个值重复一次；.irpc 对每个字符。', '.rept n … .endr repeats the block; .irp sym, v1, v2 … .endr once per value; .irpc once per character.'), '.irp r, x19, x20\n    mov \\r, #0\n.endr'),
        dir('.if', T('条件汇编', 'Conditional assembly'), T('.if 表达式 … [.elseif …] [.else] … .endif；还有 .ifdef、.ifndef、.ifeq、.ifne、.ifgt、.ifge、.iflt、.ifle、.ifc、.ifnc、.ifb、.ifnb。', '.if expr … [.elseif …] [.else] … .endif; also .ifdef, .ifndef, .ifeq, .ifne, .ifgt, .ifge, .iflt, .ifle, .ifc, .ifnc, .ifb, .ifnb.'), 'DEBUG = 1\n.if DEBUG\n    bl dump\n.endif'),
        dir('.include', T('包含文件', 'Include a file'), T('.include "文件名" 把“文件”面板里的另一个文件插进来。', '.include "name" inserts another file from the Files panel.'), '.include "macros.s"'),
        dir('.error', T('报错', 'Report an error'), T('.error "文字" 让汇编失败并显示这段文字；.warning 只给警告。', '.error "text" fails assembly with this text; .warning only warns.'), '.error "unsupported"'),
      ],
    },
    {
      title: T('标签', 'Labels'),
      rows: [
        dir('1:', T('数字局部标签', 'Numeric local labels'), T('数字加冒号是可以重复定义的局部标签；1b 指向前面最近的 1:，1f 指向后面最近的 1:。', 'A number with a colon is a local label that may be defined again; 1b means the nearest 1: before, 1f the nearest after.'), '1:  subs x0, x0, #1\n    b.ne 1b'),
      ],
    },
  ],
}

export const REFERENCES: ReferenceTable[] = [SYSCALLS_TABLE, LIBC_TABLE, CONDITIONS, SYSREG_TABLE, EXCEPTIONS, DIRECTIVES_TABLE]
