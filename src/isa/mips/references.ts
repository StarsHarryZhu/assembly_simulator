/**
 * Longer references for instructions a one-line description cannot explain:
 * - `syscall`: every service picked by `$v0`, what it reads and what it writes (from `runSyscall`);
 * - `mfc0`/`mtc0`/`eret`: the coprocessor 0 registers this machine has;
 * - exceptions: the codes a `.ktext` handler can catch (from `CAUSE` in cpu.ts);
 * - the floating-point condition flags shared by compares, `bc1t`/`bc1f` and conditional moves;
 * - every assembler directive (from the directive handling in assembler.ts), with an example.
 * Written in our own words from what the engine does; tests check the codes against the engine.
 */
import { T, type Text } from '../../core/i18n'
import type { RefRegister, RefRow, ReferenceTable } from '../../core/isa'

const r = (reg: string, zh: string, en: string): RefRegister => ({ reg, text: T(zh, en) })
const service = (code: number, title: Text, args: RefRegister[], results: RefRegister[], note?: Text): RefRow => ({
  key: String(code),
  title,
  args,
  results,
  ...(note ? { note } : {}),
})
const row = (key: string, title: Text, text: Text, note?: Text): RefRow => ({ key, title, text, ...(note ? { note } : {}) })
const dir = (key: string, title: Text, text: Text, example: string, note?: Text): RefRow => ({ ...row(key, title, text, note), example })

/* ---------------------------------------------------------------- syscall */

const MESSAGE = r('$a0', '提示文字的地址（以 \\0 结尾）', 'address of the message (ends with \\0)')
const STREAM = r('$a0', '随机数发生器编号（任意整数）', 'random generator id (any integer)')
const STATUS = r('$a1', '状态：0 正常，−1 格式不对，−2 取消，−3 没填就确定', 'status: 0 OK, −1 bad format, −2 cancelled, −3 OK with nothing typed')
const NOTE_ARGS = [
  r('$a0', '音高 0–127（60 是中央 C）', 'pitch 0–127 (60 is middle C)'),
  r('$a1', '时长，毫秒（负数按 1000）', 'duration in ms (negative means 1000)'),
  r('$a2', '乐器 0–127', 'instrument 0–127'),
  r('$a3', '音量 0–127', 'volume 0–127'),
]
const NOTE_RANGE = T('超出 0–127 的音高、乐器、音量分别按 60、0、100 处理。', 'A pitch, instrument or volume outside 0–127 becomes 60, 0 or 100.')

export const SYSCALL_SERVICES: ReferenceTable = {
  id: 'syscall',
  mnemonics: ['syscall'],
  title: T('系统调用服务', 'System call services'),
  intro: T(
    '先把服务编号放进 $v0，参数放进表里列出的寄存器，再执行 syscall。没列在“结果”里的寄存器不会改变。编号不在表里时运行出错。',
    'Put the service number in $v0 and the arguments in the registers listed, then run syscall. Registers not listed as results keep their values. Any other number is a runtime error.',
  ),
  keyTitle: T('$v0', '$v0'),
  groups: [
    {
      title: T('终端输出', 'Console output'),
      rows: [
        service(1, T('打印整数', 'Print integer'), [r('$a0', '要打印的整数（有符号十进制）', 'the integer (signed decimal)')], []),
        service(2, T('打印单精度浮点数', 'Print float'), [r('$f12', '要打印的 float', 'the float')], []),
        service(3, T('打印双精度浮点数', 'Print double'), [r('$f12', '要打印的 double（$f12 和 $f13 两个寄存器）', 'the double (the pair $f12, $f13)')], []),
        service(4, T('打印字符串', 'Print string'), [r('$a0', '字符串的地址，打印到 \\0 为止', 'address of the string; prints up to its \\0')], []),
        service(11, T('打印字符', 'Print character'), [r('$a0', '字符，只用最低 8 位', 'the character (low 8 bits)')], []),
        service(34, T('按十六进制打印整数', 'Print integer in hex'), [r('$a0', '整数，打印成 0x 加 8 位十六进制', 'the integer, printed as 0x and 8 hex digits')], []),
        service(35, T('按二进制打印整数', 'Print integer in binary'), [r('$a0', '整数，打印成 32 位二进制', 'the integer, printed as 32 binary digits')], []),
        service(36, T('按无符号数打印整数', 'Print integer as unsigned'), [r('$a0', '整数，按无符号十进制打印', 'the integer, printed as unsigned decimal')], []),
      ],
    },
    {
      title: T('终端输入', 'Console input'),
      rows: [
        service(5, T('读取整数', 'Read integer'), [], [r('$v0', '读到的整数', 'the integer typed')], T('输入的不是整数时运行出错。', 'Input that is not an integer is a runtime error.')),
        service(6, T('读取单精度浮点数', 'Read float'), [], [r('$f0', '读到的 float', 'the float typed')], T('输入的不是数字时运行出错。', 'Input that is not a number is a runtime error.')),
        service(7, T('读取双精度浮点数', 'Read double'), [], [r('$f0', '读到的 double（$f0 和 $f1）', 'the double typed (the pair $f0, $f1)')], T('输入的不是数字时运行出错。', 'Input that is not a number is a runtime error.')),
        service(
          8,
          T('读取字符串', 'Read string'),
          [r('$a0', '缓冲区地址', 'address of the buffer'), r('$a1', '缓冲区大小（字节）', 'size of the buffer in bytes')],
          [],
          T('最多存 $a1−1 个字节（包括换行符），后面补一个 \\0。', 'Stores at most $a1−1 bytes (newline included), then a \\0.'),
        ),
        service(12, T('读取字符', 'Read character'), [], [r('$v0', '读到的字符', 'the character typed')]),
      ],
    },
    {
      title: T('内存和退出', 'Memory and exit'),
      rows: [
        service(
          9,
          T('sbrk：在堆上申请内存', 'sbrk: allocate heap memory'),
          [r('$a0', '要申请的字节数', 'number of bytes')],
          [r('$v0', '这块内存的起始地址', 'address of the new block')],
          T('堆顶会向上取整到 4 的倍数；字节数为负时运行出错。', 'The heap top is rounded up to a multiple of 4; a negative size is a runtime error.'),
        ),
        service(10, T('结束程序', 'Exit'), [], []),
        service(17, T('带返回值结束程序', 'Exit with a value'), [r('$a0', '返回值', 'exit value')], []),
      ],
    },
    {
      title: T('文件', 'Files'),
      rows: [
        service(
          13,
          T('打开文件', 'Open file'),
          [r('$a0', '文件名的地址', 'address of the file name'), r('$a1', '方式：0 读，1 写（新建或清空），9 追加', 'flags: 0 read, 1 write (create or empty), 9 append')],
          [r('$v0', '文件描述符（≥ 3），出错时是负数', 'file descriptor (≥ 3), negative on error')],
          T('$a2（权限）不使用。文件在“文件”面板里，可以上传和下载。', '$a2 (mode) is ignored. Files live in the Files panel, where you can upload and download them.'),
        ),
        service(
          14,
          T('读文件', 'Read from file'),
          [r('$a0', '文件描述符', 'file descriptor'), r('$a1', '缓冲区地址', 'address of the buffer'), r('$a2', '最多读多少字节', 'maximum number of bytes')],
          [r('$v0', '读到的字节数，文件末尾为 0，出错时是负数', 'bytes read: 0 at end of file, negative on error')],
          T('描述符 0 从键盘读一行。', 'Descriptor 0 reads a line from the keyboard.'),
        ),
        service(
          15,
          T('写文件', 'Write to file'),
          [r('$a0', '文件描述符', 'file descriptor'), r('$a1', '要写的数据的地址', 'address of the data'), r('$a2', '字节数', 'number of bytes')],
          [r('$v0', '写入的字节数，出错时是负数', 'bytes written, negative on error')],
          T('描述符 1 和 2 写到终端。', 'Descriptors 1 and 2 write to the terminal.'),
        ),
        service(16, T('关闭文件', 'Close file'), [r('$a0', '文件描述符', 'file descriptor')], []),
      ],
    },
    {
      title: T('时间和声音', 'Time and sound'),
      rows: [
        service(
          30,
          T('读取系统时间', 'System time'),
          [],
          [r('$a0', '自 1970-01-01 起的毫秒数，低 32 位', 'milliseconds since 1970-01-01, low 32 bits'), r('$a1', '同一个数的高 32 位', 'the same number, high 32 bits')],
        ),
        service(31, T('播放一个音符', 'Play a note'), NOTE_ARGS, [], T(`不等音符结束，马上往下执行。${NOTE_RANGE.zh}`, `Returns at once, without waiting for the note. ${NOTE_RANGE.en}`)),
        service(32, T('暂停', 'Sleep'), [r('$a0', '暂停多少毫秒', 'milliseconds to wait')], []),
        service(33, T('播放音符并等它结束', 'Play a note and wait'), NOTE_ARGS, [], T(`等音符放完再往下执行。${NOTE_RANGE.zh}`, `Waits until the note ends. ${NOTE_RANGE.en}`)),
      ],
    },
    {
      title: T('随机数', 'Random numbers'),
      rows: [
        service(
          40,
          T('设置随机数种子', 'Set seed'),
          [STREAM, r('$a1', '种子', 'seed')],
          [],
          T(
            '同一个种子总是得到同一串数（和 Java 的 Random 一样）。没设过种子的发生器按当前时间取种子。',
            'The same seed always gives the same numbers (as Java’s Random does). A generator never seeded starts from the current time.',
          ),
        ),
        service(41, T('随机整数', 'Random integer'), [STREAM], [r('$a0', '任意 32 位整数', 'any 32-bit integer')]),
        service(
          42,
          T('范围内的随机整数', 'Random integer in a range'),
          [STREAM, r('$a1', '上限（不含）', 'upper bound (excluded)')],
          [r('$a0', '0 到 $a1−1 之间的整数', 'an integer from 0 to $a1−1')],
          T('上限不是正数时运行出错。', 'An upper bound that is not positive is a runtime error.'),
        ),
        service(43, T('随机单精度浮点数', 'Random float'), [STREAM], [r('$f0', '0 到 1 之间（不含 1）的 float', 'a float from 0 up to (not including) 1')]),
        service(44, T('随机双精度浮点数', 'Random double'), [STREAM], [r('$f0', '0 到 1 之间（不含 1）的 double（$f0 和 $f1）', 'a double from 0 up to (not including) 1 (the pair $f0, $f1)')]),
      ],
    },
    {
      title: T('对话框', 'Dialogs'),
      rows: [
        service(50, T('确认对话框', 'Confirm dialog'), [MESSAGE], [r('$a0', '0 是，1 否，2 取消', '0 yes, 1 no, 2 cancel')]),
        service(51, T('输入整数对话框', 'Input integer dialog'), [MESSAGE], [r('$a0', '输入的整数（状态为 0 时）', 'the integer (when the status is 0)'), STATUS]),
        service(52, T('输入单精度浮点数对话框', 'Input float dialog'), [MESSAGE], [r('$f0', '输入的 float（状态为 0 时）', 'the float (when the status is 0)'), STATUS]),
        service(53, T('输入双精度浮点数对话框', 'Input double dialog'), [MESSAGE], [r('$f0', '输入的 double（$f0 和 $f1，状态为 0 时）', 'the double (the pair $f0, $f1, when the status is 0)'), STATUS]),
        service(
          54,
          T('输入字符串对话框', 'Input string dialog'),
          [MESSAGE, r('$a1', '缓冲区地址', 'address of the buffer'), r('$a2', '缓冲区大小（字节）', 'size of the buffer in bytes')],
          [r('$a1', '状态：0 正常，−2 取消，−3 没填就确定，−4 太长被截断', 'status: 0 OK, −2 cancelled, −3 OK with nothing typed, −4 too long, cut short')],
          T('最多存 $a2−1 个字节，后面补一个 \\0。', 'Stores at most $a2−1 bytes, then a \\0.'),
        ),
        service(55, T('消息对话框', 'Message dialog'), [MESSAGE, r('$a1', '类型：0 错误，1 信息，2 警告，3 提问，其他为普通', 'kind: 0 error, 1 information, 2 warning, 3 question, anything else plain')], []),
        service(56, T('消息加整数', 'Message with an integer'), [MESSAGE, r('$a1', '接在消息后面显示的整数', 'integer shown after the message')], []),
        service(57, T('消息加单精度浮点数', 'Message with a float'), [MESSAGE, r('$f12', '接在消息后面显示的 float', 'float shown after the message')], []),
        service(58, T('消息加双精度浮点数', 'Message with a double'), [MESSAGE, r('$f12', '接在消息后面显示的 double（$f12 和 $f13）', 'double shown after the message (the pair $f12, $f13)')], []),
        service(59, T('消息加字符串', 'Message with a string'), [MESSAGE, r('$a1', '接在消息后面显示的字符串的地址', 'address of the string shown after the message')], []),
      ],
    },
  ],
}

/* ---------------------------------------------------------------- coprocessor 0 and exceptions */

const TRAPS = ['teq', 'teqi', 'tne', 'tnei', 'tge', 'tgeu', 'tgei', 'tgeiu', 'tlt', 'tltu', 'tlti', 'tltiu']

export const CP0_REGISTERS: ReferenceTable = {
  id: 'cp0',
  mnemonics: ['mfc0', 'mtc0', 'eret'],
  title: T('协处理器 0 的寄存器', 'Coprocessor 0 registers'),
  intro: T(
    'mfc0 $t0, $13 把协处理器 0 的 13 号寄存器读进 $t0，mtc0 反过来写入。这台机器只有下面 4 个；别的编号读出来是 0，写入不起作用。异常处理程序（.ktext）靠它们知道出了什么错、该回到哪里。',
    'mfc0 $t0, $13 copies coprocessor 0 register 13 into $t0; mtc0 writes the other way. This machine has only the 4 below; any other number reads as 0 and ignores writes. An exception handler (.ktext) uses them to learn what went wrong and where to return.',
  ),
  keyTitle: T('编号', 'Number'),
  groups: [
    {
      rows: [
        row('$8', T('vaddr：出错地址', 'vaddr: bad address'), T('读写内存时地址越界或没对齐，出错的那个地址写在这里。', 'When a load or store uses an address that is out of range or not aligned, that address is put here.')),
        row(
          '$12',
          T('status：状态', 'status'),
          T(
            '第 1 位（EXL）在进入异常处理程序时置 1，eret 把它清零。开始时是 0x0000ff11；其余的位（中断允许、中断屏蔽、用户模式）这里没有中断，不起作用。',
            'Bit 1 (EXL) is set when the exception handler is entered and cleared by eret. It starts as 0x0000ff11; the other bits (interrupt enable, interrupt mask, user mode) have no effect here, as there are no interrupts.',
          ),
        ),
        row(
          '$13',
          T('cause：原因', 'cause'),
          T('第 2–6 位是异常代码（见“异常和异常代码”）。取出它：andi $k0, $k0, 0x7c，再 srl $k0, $k0, 2。', 'Bits 2–6 hold the exception code (see "Exceptions and their codes"). To get it: andi $k0, $k0, 0x7c, then srl $k0, $k0, 2.'),
        ),
        row(
          '$14',
          T('epc：异常地址', 'epc: exception address'),
          T('出错的那条指令自己的地址（不是下一条）。eret 跳回这里；想跳过出错的指令，先给它加 4 再 eret。', 'The address of the instruction that failed (not the next one). eret jumps back here; to skip the failing instruction, add 4 to it before eret.'),
        ),
      ],
    },
  ],
}

export const EXCEPTIONS: ReferenceTable = {
  id: 'exceptions',
  mnemonics: ['mfc0', 'mtc0', 'eret', 'break', ...TRAPS],
  title: T('异常和异常代码', 'Exceptions and their codes'),
  intro: T(
    '程序里有 .ktext 段时，下面这些错误会交给异常处理程序：CPU 把出错指令的地址写进 epc（$14），把代码写进 cause（$13）的第 2–6 位，地址错误还会把地址写进 vaddr（$8），再把 status（$12）的 EXL 位置 1，然后跳到 0x80000180。处理程序用 eret 返回 epc。没有 .ktext 时，或者处理程序自己出错时，程序直接停下并报错。系统调用自己报的错（比如输入的格式不对、服务编号不存在）不会交给处理程序。',
    'When the program has a .ktext section, the errors below go to the exception handler: the CPU puts the failing instruction’s address in epc ($14), the code in bits 2–6 of cause ($13), the address in vaddr ($8) for address errors, sets the EXL bit of status ($12), and jumps to 0x80000180. The handler returns to epc with eret. Without .ktext, or when the handler itself fails, the program stops with an error. Errors a system call reports itself (badly formatted input, an unknown service number) never reach the handler.',
  ),
  keyTitle: T('代码', 'Code'),
  groups: [
    {
      rows: [
        row('4', T('AdEL：读取地址错误', 'AdEL: address error on load'), T('读内存的地址越界，或者没有对齐（比如 lw 的地址不是 4 的倍数）。', 'A load from an address out of range or not aligned (for example lw from an address that is not a multiple of 4).')),
        row('5', T('AdES：写入地址错误', 'AdES: address error on store'), T('写内存的地址越界、没有对齐，或者写到了代码段。', 'A store to an address out of range, not aligned, or inside the text segment.')),
        row('9', T('Bp：断点', 'Bp: breakpoint'), T('执行了 break 指令。', 'A break instruction ran.')),
        row('12', T('Ov：算术溢出', 'Ov: arithmetic overflow'), T('add、addi、sub（以及用到它们的伪指令）的结果超出 32 位有符号数的范围。addu、addiu、subu 不检查溢出。', 'The result of add, addi or sub (or a pseudo-instruction built on them) does not fit in a signed 32-bit integer. addu, addiu and subu never check.')),
        row('13', T('Tr：陷阱', 'Tr: trap'), T('teq、tne、tge、tlt 等陷阱指令的条件成立。', 'The condition of a trap instruction (teq, tne, tge, tlt and the rest) holds.')),
      ],
    },
  ],
}

/* ---------------------------------------------------------------- floating-point condition flags */

export const FP_FLAGS: ReferenceTable = {
  id: 'fcc',
  mnemonics: ['c.eq.s', 'c.lt.s', 'c.le.s', 'c.eq.d', 'c.lt.d', 'c.le.d', 'bc1t', 'bc1f', 'movt', 'movf', 'movt.s', 'movf.s', 'movt.d', 'movf.d'],
  title: T('浮点条件标志', 'Floating-point condition flags'),
  intro: T(
    '协处理器 1 有 8 个条件标志（0–7），开始都是 0。比较指令把结果写进一个标志，条件分支和条件移动读一个标志；不写标志编号就用 0 号。和 NaN 比较的结果总是假。常见写法：c.lt.s $f0, $f2 之后 bc1t smaller。',
    'Coprocessor 1 has 8 condition flags (0–7), all 0 at the start. A compare writes one flag; conditional branches and moves read one. Without a flag number, flag 0 is used. Any comparison with NaN is false. A common pattern: c.lt.s $f0, $f2 followed by bc1t smaller.',
  ),
  keyTitle: T('指令', 'Instruction'),
  groups: [
    {
      title: T('比较：写标志', 'Compare: write a flag'),
      rows: [
        row('c.eq.s  c.eq.d', T('相等', 'Equal'), T('标志 ← （第一个数 = 第二个数）', 'flag ← (first = second)')),
        row('c.lt.s  c.lt.d', T('小于', 'Less than'), T('标志 ← （第一个数 < 第二个数）', 'flag ← (first < second)')),
        row('c.le.s  c.le.d', T('小于等于', 'Less or equal'), T('标志 ← （第一个数 ≤ 第二个数）', 'flag ← (first ≤ second)')),
      ],
    },
    {
      title: T('读标志', 'Read a flag'),
      rows: [
        row('bc1t  bc1f', T('条件分支', 'Branch on a flag'), T('bc1t 在标志为 1 时跳转，bc1f 在标志为 0 时跳转。', 'bc1t branches when the flag is 1, bc1f when it is 0.')),
        row('movt  movf', T('条件移动整数寄存器', 'Conditional move, integer'), T('movt $t0, $t1, 2：标志 2 为 1 时 $t0 ← $t1；movf 在标志为 0 时移动。', 'movt $t0, $t1, 2: $t0 ← $t1 when flag 2 is 1; movf moves when it is 0.')),
        row('movt.s  movf.s', T('条件移动单精度', 'Conditional move, float'), T('和 movt/movf 一样，但移动的是 float 寄存器。', 'Like movt/movf, but on float registers.')),
        row('movt.d  movf.d', T('条件移动双精度', 'Conditional move, double'), T('和 movt/movf 一样，但移动的是 double 寄存器对。', 'Like movt/movf, but on double register pairs.')),
      ],
    },
  ],
}

/* ---------------------------------------------------------------- directives */

const MACRO_EXAMPLE = '.macro push(%r)\n    addi $sp, $sp, -4\n    sw %r, 0($sp)\n.end_macro'

export const DIRECTIVE_REFERENCE: ReferenceTable = {
  id: 'directives',
  mnemonics: [],
  title: T('伪操作', 'Directives'),
  intro: T(
    '以点开头的词不是指令，不会变成机器码：它们告诉汇编器把东西放在哪个段、怎样放数据、怎样替换文字。数据伪操作只能写在 .data 或 .kdata 里，前面通常带一个标签，比如 msg: .asciiz "Hi"，以后用 la $a0, msg 取它的地址。',
    'Words that start with a dot are not instructions and produce no machine code: they tell the assembler which segment to use, how to lay out data, and what text to replace. Data directives belong in .data or .kdata, usually after a label, as in msg: .asciiz "Hi", whose address la $a0, msg then loads.',
  ),
  keyTitle: T('伪操作', 'Directive'),
  groups: [
    {
      title: T('段', 'Segments'),
      rows: [
        dir('.text', T('代码段', 'Text segment'), T('后面的指令放进代码段，默认从 0x00400000 开始。可以跟一个地址，从那里接着放。', 'What follows goes into the text segment, from 0x00400000 by default. An address after it continues from there.'), '.text'),
        dir(
          '.data',
          T('数据段', 'Data segment'),
          T('后面的数据放进数据段，默认从 0x10010000 开始，也可以跟地址。数据段里不能写指令。', 'What follows goes into the data segment, from 0x10010000 by default; an address may follow. No instructions here.'),
          '.data',
          T('每次进入数据段都会重新打开自动对齐（见 .align）。', 'Entering a data segment turns automatic alignment back on (see .align).'),
        ),
        dir('.ktext', T('内核代码段', 'Kernel text segment'), T('内核代码，默认从 0x80000000 开始。异常处理程序写在 .ktext 0x80000180。', 'Kernel code, from 0x80000000 by default. The exception handler goes at .ktext 0x80000180.'), '.ktext 0x80000180'),
        dir('.kdata', T('内核数据段', 'Kernel data segment'), T('内核数据，默认从 0x90000000 开始，给异常处理程序存数据。', 'Kernel data, from 0x90000000 by default, for the exception handler to keep its data.'), '.kdata'),
      ],
    },
    {
      title: T('数据', 'Data'),
      rows: [
        dir(
          '.word',
          T('32 位整数', '32-bit words'),
          T('每个值占 4 字节，可以写整数，也可以写标签（存它的地址）。值:次数 表示重复，比如 0:10 是 10 个 0。自动对齐到 4 字节。', 'Each value takes 4 bytes: an integer, or a label (its address is stored). value:count repeats, so 0:10 is ten zeros. Aligned to 4 bytes automatically.'),
          'nums: .word 1, -2, 0xff, 0:4',
        ),
        dir(
          '.half',
          T('16 位整数', '16-bit halfwords'),
          T('每个值占 2 字节，自动对齐到 2 字节。', 'Each value takes 2 bytes, aligned to 2 bytes automatically.'),
          'h: .half 1000, -1, 0:3',
          T('超出 −32768–32767 时给出警告，只保留低 16 位。', 'A value outside −32768–32767 gives a warning and keeps only its low 16 bits.'),
        ),
        dir(
          '.byte',
          T('8 位整数', 'Bytes'),
          T('每个值占 1 字节，也可以写字符，比如 \'A\'。', "Each value takes 1 byte; a character such as 'A' works too."),
          "b: .byte 1, 'A', -1",
          T('超出 −128–127 时给出警告，只保留低 8 位。', 'A value outside −128–127 gives a warning and keeps only its low 8 bits.'),
        ),
        dir('.float', T('单精度浮点数', 'Floats'), T('每个值占 4 字节，自动对齐到 4 字节。只能写十进制（1.5、-2e3），不能写十六进制。', 'Each value takes 4 bytes, aligned to 4 automatically. Decimal only (1.5, -2e3), never hex.'), 'f: .float 3.14, -1.5e2'),
        dir('.double', T('双精度浮点数', 'Doubles'), T('每个值占 8 字节，自动对齐到 8 字节。也能用 值:次数 重复。', 'Each value takes 8 bytes, aligned to 8 automatically. value:count repeats here too.'), 'd: .double 2.718281828, 0:2'),
        dir('.ascii', T('字符串（不加 \\0）', 'String without \\0'), T('把字符串的字节依次放进内存，结尾不加 \\0。可以写几个字符串；支持 \\n、\\t、\\" 等转义。', 'Stores the string’s bytes with no \\0 at the end. Several strings may follow; escapes such as \\n, \\t and \\" work.'), 's: .ascii "abc"'),
        dir('.asciiz', T('字符串（加 \\0）', 'String with \\0'), T('和 .ascii 一样，但每个字符串后面补一个 \\0。syscall 4 打印的就是这种字符串。', 'Like .ascii, but each string ends with a \\0. This is the kind of string syscall 4 prints.'), 'msg: .asciiz "Hello\\n"'),
        dir(
          '.space',
          T('留出空间', 'Reserve space'),
          T('留出 n 个字节，内容都是 0。', 'Reserves n bytes, all zero.'),
          'buf: .space 64',
          T('不会自动对齐：要按字读写的话，前面先写 .align 2。', 'It is not aligned automatically: to use it with word loads and stores, put .align 2 before it.'),
        ),
        dir(
          '.align',
          T('对齐', 'Align'),
          T('把下一个数据对齐到 2 的 n 次方字节（n 为 0–21）：.align 2 是 4 字节，.align 3 是 8 字节。', 'Aligns the next data to 2^n bytes (n from 0 to 21): .align 2 is 4 bytes, .align 3 is 8.'),
          '.align 2',
          T('.align 0 关掉自动对齐，直到下一个 .data 或 .kdata。', '.align 0 turns automatic alignment off until the next .data or .kdata.'),
        ),
      ],
    },
    {
      title: T('符号', 'Symbols'),
      rows: [
        dir('.globl', T('全局标签', 'Global label'), T('把标签声明成全局的。这里只有一个源文件，所以可以写，但不起作用。', 'Declares a label global. With a single source file here, it is accepted and has no effect.'), '.globl main'),
        dir(
          '.extern',
          T('外部变量', 'External variable'),
          T('在外部变量区（从 0x10000000 开始）留出指定的字节数，并用这个标签指向它。标签已经定义过时不起作用。', 'Reserves the given number of bytes in the extern area (from 0x10000000) and points the label at them. Does nothing if the label already exists.'),
          '.extern counter 4',
        ),
        dir(
          '.eqv',
          T('文字替换', 'Text substitution'),
          T('给一段文字起名字：后面的代码里，每个这个名字都换成那段文字，常用来命名常数或寄存器。', 'Names a piece of text: from here on, every use of the name is replaced by the text. Handy for constants and registers.'),
          '.eqv SIZE 40',
          T('名字不能和指令或伪操作同名。', 'The name cannot be an instruction or directive.'),
        ),
      ],
    },
    {
      title: T('宏和文件', 'Macros and files'),
      rows: [
        dir(
          '.macro',
          T('定义宏', 'Define a macro'),
          T('开始定义宏，到 .end_macro 结束。参数以 % 开头；调用写成 名字(参数, …) 或 名字 参数, …。宏要先定义再使用。', 'Starts a macro, which ends at .end_macro. Parameters start with %; call it as name(args, …) or name args, …. Define a macro before using it.'),
          MACRO_EXAMPLE,
          T('参数个数不同的同名宏可以并存；宏里的标签每次展开都会改名，不会重复；宏里不能再定义宏。', 'Macros may share a name if their parameter counts differ; labels inside a macro are renamed on every use, so they never clash; a macro cannot define another macro.'),
        ),
        dir('.end_macro', T('结束宏', 'End a macro'), T('结束 .macro 开始的宏定义。', 'Ends the macro started by .macro.'), MACRO_EXAMPLE),
        dir(
          '.include',
          T('包含文件', 'Include a file'),
          T('把另一个文件的内容原样插到这里。文件要先在“文件”面板里添加；最多嵌套 8 层。', 'Inserts another file’s text here. Add the file in the Files panel first; includes nest at most 8 deep.'),
          '.include "macros.asm"',
        ),
      ],
    },
    {
      title: T('其他', 'Other'),
      rows: [dir('.set', T('汇编器选项', 'Assembler option'), T('其他汇编器（比如 GNU as）用的写法，这里会被忽略，并给出警告。', 'Written for other assemblers (such as GNU as); ignored here, with a warning.'), '.set noreorder')],
    },
  ],
}
DIRECTIVE_REFERENCE.mnemonics = DIRECTIVE_REFERENCE.groups.flatMap((g) => g.rows.map((r) => r.key))

export const REFERENCES: ReferenceTable[] = [SYSCALL_SERVICES, CP0_REGISTERS, EXCEPTIONS, FP_FLAGS, DIRECTIVE_REFERENCE]
