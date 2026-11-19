/**
 * English descriptions of the basic instructions, keyed by the Chinese text used in the tables.
 * tests/mips/i18n.test.ts checks that every basic instruction has an entry.
 */
export const EN_DESC: Record<string, string> = {
  "空操作：机器码全为 0（其实就是 sll $zero, $zero, 0）":
    "No operation: the machine code is all zeros (really sll $zero, $zero, 0)",
  "{rd} ← {rs} + {rt}，有符号溢出时触发异常":
    "{rd} ← {rs} + {rt}; traps on signed overflow",
  "{rd} ← {rs} − {rt}，有符号溢出时触发异常":
    "{rd} ← {rs} − {rt}; traps on signed overflow",
  "{rt} ← {rs} + {imm}（立即数符号扩展），溢出时触发异常":
    "{rt} ← {rs} + {imm} (immediate sign-extended); traps on overflow",
  "{rd} ← {rs} + {rt}，不检查溢出":
    "{rd} ← {rs} + {rt}, no overflow check",
  "{rd} ← {rs} − {rt}，不检查溢出":
    "{rd} ← {rs} − {rt}, no overflow check",
  "{rt} ← {rs} + {imm}（立即数符号扩展），不检查溢出":
    "{rt} ← {rs} + {imm} (immediate sign-extended), no overflow check",
  "HI:LO ← {rs} × {rt}（有符号 64 位积）":
    "HI:LO ← {rs} × {rt} (signed 64-bit product)",
  "HI:LO ← {rs} × {rt}（无符号 64 位积）":
    "HI:LO ← {rs} × {rt} (unsigned 64-bit product)",
  "{rd} ← {rs} × {rt} 的低 32 位；HI、LO 同时写入完整的 64 位积":
    "{rd} ← low 32 bits of {rs} × {rt}; HI and LO also receive the full 64-bit product",
  "HI:LO ← HI:LO + {rs} × {rt}（有符号）":
    "HI:LO ← HI:LO + {rs} × {rt} (signed)",
  "HI:LO ← HI:LO + {rs} × {rt}（无符号）":
    "HI:LO ← HI:LO + {rs} × {rt} (unsigned)",
  "HI:LO ← HI:LO − {rs} × {rt}（有符号）":
    "HI:LO ← HI:LO − {rs} × {rt} (signed)",
  "HI:LO ← HI:LO − {rs} × {rt}（无符号）":
    "HI:LO ← HI:LO − {rs} × {rt} (unsigned)",
  "LO ← {rs} ÷ {rt} 的商，HI ← 余数（有符号）。除数为 0 时 HI、LO 不变":
    "LO ← quotient of {rs} ÷ {rt}, HI ← remainder (signed). A zero divisor leaves HI and LO unchanged",
  "LO ← {rs} ÷ {rt} 的商，HI ← 余数（无符号）。除数为 0 时 HI、LO 不变":
    "LO ← quotient of {rs} ÷ {rt}, HI ← remainder (unsigned). A zero divisor leaves HI and LO unchanged",
  "{rd} ← HI":
    "{rd} ← HI",
  "{rd} ← LO":
    "{rd} ← LO",
  "HI ← {rs}":
    "HI ← {rs}",
  "LO ← {rs}":
    "LO ← {rs}",
  "{rd} ← {rs} & {rt}（按位与）":
    "{rd} ← {rs} & {rt} (bitwise AND)",
  "{rd} ← {rs} | {rt}（按位或）":
    "{rd} ← {rs} | {rt} (bitwise OR)",
  "{rt} ← {rs} & {immu}（立即数零扩展）":
    "{rt} ← {rs} & {immu} (immediate zero-extended)",
  "{rt} ← {rs} | {immu}（立即数零扩展，高 16 位不受影响）":
    "{rt} ← {rs} | {immu} (immediate zero-extended; the upper 16 bits are unchanged)",
  "{rd} ← ~({rs} | {rt})（或非）":
    "{rd} ← ~({rs} | {rt}) (NOR)",
  "{rd} ← {rs} ^ {rt}（按位异或）":
    "{rd} ← {rs} ^ {rt} (bitwise XOR)",
  "{rt} ← {rs} ^ {immu}（立即数零扩展）":
    "{rt} ← {rs} ^ {immu} (immediate zero-extended)",
  "{rd} ← {rt} 左移 {sa} 位（低位补 0，相当于 × 2^{sa}）":
    "{rd} ← {rt} shifted left by {sa} bits (zeros shifted in; same as × 2^{sa})",
  "{rd} ← {rt} 左移（{rs} 的低 5 位）位":
    "{rd} ← {rt} shifted left by (low 5 bits of {rs}) bits",
  "{rd} ← {rt} 逻辑右移 {sa} 位（高位补 0）":
    "{rd} ← {rt} shifted right logically by {sa} bits (zeros shifted in)",
  "{rd} ← {rt} 算术右移 {sa} 位（高位补符号位）":
    "{rd} ← {rt} shifted right arithmetically by {sa} bits (sign bit shifted in)",
  "{rd} ← {rt} 算术右移（{rs} 的低 5 位）位":
    "{rd} ← {rt} shifted right arithmetically by (low 5 bits of {rs}) bits",
  "{rd} ← {rt} 逻辑右移（{rs} 的低 5 位）位":
    "{rd} ← {rt} shifted right logically by (low 5 bits of {rs}) bits",
  "{rt} ← {immu} << 16（低 16 位清零）":
    "{rt} ← {immu} << 16 (low 16 bits cleared)",
  "{rd} ← ({rs} < {rt}) ? 1 : 0（有符号比较）":
    "{rd} ← ({rs} < {rt}) ? 1 : 0 (signed comparison)",
  "{rd} ← ({rs} < {rt}) ? 1 : 0（无符号比较）":
    "{rd} ← ({rs} < {rt}) ? 1 : 0 (unsigned comparison)",
  "{rt} ← ({rs} < {imm}) ? 1 : 0（有符号比较）":
    "{rt} ← ({rs} < {imm}) ? 1 : 0 (signed comparison)",
  "{rt} ← ({rs} < {imm}) ? 1 : 0（立即数先符号扩展，再按无符号比较）":
    "{rt} ← ({rs} < {imm}) ? 1 : 0 (immediate sign-extended, then compared unsigned)",
  "若 {rt} ≠ 0，则 {rd} ← {rs}":
    "If {rt} ≠ 0, {rd} ← {rs}",
  "若 {rt} = 0，则 {rd} ← {rs}":
    "If {rt} = 0, {rd} ← {rs}",
  "若浮点条件标志 0 为假，则 {rd} ← {rs}":
    "If FP condition flag 0 is false, {rd} ← {rs}",
  "若浮点条件标志 {cc} 为假，则 {rd} ← {rs}":
    "If FP condition flag {cc} is false, {rd} ← {rs}",
  "若浮点条件标志 0 为真，则 {rd} ← {rs}":
    "If FP condition flag 0 is true, {rd} ← {rs}",
  "若浮点条件标志 {cc} 为真，则 {rd} ← {rs}":
    "If FP condition flag {cc} is true, {rd} ← {rs}",
  "{rd} ← {rs} 从最高位开始连续 1 的个数":
    "{rd} ← number of leading 1 bits in {rs}",
  "{rd} ← {rs} 从最高位开始连续 0 的个数":
    "{rd} ← number of leading 0 bits in {rs}",
  "{rt} ← 内存[{mem}] 的 4 字节（地址必须是 4 的倍数）":
    "{rt} ← 4 bytes of memory[{mem}] (address must be a multiple of 4)",
  "载入链接：和 lw 一样读 4 字节（MARS 只有单处理器，总会成功）":
    "Load linked: reads 4 bytes like lw (MARS has one processor, so it always succeeds)",
  "非对齐读取左半部分：把 {mem} 所在字的高位字节并入 {rt} 的高位":
    "Unaligned load, left part: merges the high-order bytes of the word holding {mem} into the high end of {rt}",
  "非对齐读取右半部分：把 {mem} 开始到字末的字节并入 {rt} 的低位":
    "Unaligned load, right part: merges the bytes from {mem} to the end of its word into the low end of {rt}",
  "内存[{mem}] ← {rt}（4 字节，地址必须是 4 的倍数）":
    "memory[{mem}] ← {rt} (4 bytes; address must be a multiple of 4)",
  "条件存储：和 sw 一样写 4 字节，然后 {rt} ← 1 表示成功":
    "Store conditional: writes 4 bytes like sw, then {rt} ← 1 to signal success",
  "非对齐写入左半部分：把 {rt} 的高位字节写到 {mem} 及更低的地址":
    "Unaligned store, left part: writes the high-order bytes of {rt} to {mem} and the addresses below it",
  "非对齐写入右半部分：把 {rt} 的低位字节写到 {mem} 到字末":
    "Unaligned store, right part: writes the low-order bytes of {rt} from {mem} to the end of its word",
  "{rt} ← 内存[{mem}] 的 1 字节，符号扩展到 32 位":
    "{rt} ← 1 byte of memory[{mem}], sign-extended to 32 bits",
  "{rt} ← 内存[{mem}] 的 2 字节，符号扩展（地址必须是 2 的倍数）":
    "{rt} ← 2 bytes of memory[{mem}], sign-extended (address must be a multiple of 2)",
  "{rt} ← 内存[{mem}] 的 2 字节，零扩展（地址必须是 2 的倍数）":
    "{rt} ← 2 bytes of memory[{mem}], zero-extended (address must be a multiple of 2)",
  "{rt} ← 内存[{mem}] 的 1 字节，零扩展":
    "{rt} ← 1 byte of memory[{mem}], zero-extended",
  "内存[{mem}] ← {rt} 的最低 1 字节":
    "memory[{mem}] ← lowest byte of {rt}",
  "内存[{mem}] ← {rt} 的低 2 字节（地址必须是 2 的倍数）":
    "memory[{mem}] ← low 2 bytes of {rt} (address must be a multiple of 2)",
  "若 {rs} = {rt}，跳到 {off}":
    "If {rs} = {rt}, branch to {off}",
  "若 {rs} ≠ {rt}，跳到 {off}":
    "If {rs} ≠ {rt}, branch to {off}",
  "若 {rs} ≥ 0，跳到 {off}":
    "If {rs} ≥ 0, branch to {off}",
  "若 {rs} ≥ 0，$ra ← 下一条指令的地址，再跳到 {off}":
    "If {rs} ≥ 0, $ra ← address of the next instruction, then branch to {off}",
  "若 {rs} > 0，跳到 {off}":
    "If {rs} > 0, branch to {off}",
  "若 {rs} ≤ 0，跳到 {off}":
    "If {rs} ≤ 0, branch to {off}",
  "若 {rs} < 0，跳到 {off}":
    "If {rs} < 0, branch to {off}",
  "若 {rs} < 0，$ra ← 下一条指令的地址，再跳到 {off}":
    "If {rs} < 0, $ra ← address of the next instruction, then branch to {off}",
  "跳到 {tgt}（地址高 4 位沿用当前 PC）":
    "Jump to {tgt} (the top 4 address bits come from the current PC)",
  "跳到 {rs} 里存的地址":
    "Jump to the address held in {rs}",
  "$ra ← 下一条指令的地址，再跳到 {tgt}":
    "$ra ← address of the next instruction, then jump to {tgt}",
  "{rd} ← 下一条指令的地址，再跳到 {rs} 里存的地址":
    "{rd} ← address of the next instruction, then jump to the address held in {rs}",
  "$ra ← 下一条指令的地址，再跳到 {rs} 里存的地址":
    "$ra ← address of the next instruction, then jump to the address held in {rs}",
  "触发断点异常，代码 {code}":
    "Raise a breakpoint exception with code {code}",
  "触发断点异常":
    "Raise a breakpoint exception",
  "系统调用：按 $v0 里的编号请求服务（打印、读取、退出……）":
    "System call: request the service numbered in $v0 (print, read, exit, …)",
  "{rt} ← 协处理器 0 的 {c0}":
    "{rt} ← coprocessor 0 register {c0}",
  "协处理器 0 的 {c0} ← {rt}":
    "Coprocessor 0 register {c0} ← {rt}",
  "若 {rs} = {rt}，触发陷阱异常":
    "If {rs} = {rt}, raise a trap exception",
  "若 {rs} = {imm}，触发陷阱异常":
    "If {rs} = {imm}, raise a trap exception",
  "若 {rs} ≠ {rt}，触发陷阱异常":
    "If {rs} ≠ {rt}, raise a trap exception",
  "若 {rs} ≠ {imm}，触发陷阱异常":
    "If {rs} ≠ {imm}, raise a trap exception",
  "若 {rs} ≥ {rt}（有符号），触发陷阱异常":
    "If {rs} ≥ {rt} (signed), raise a trap exception",
  "若 {rs} ≥ {rt}（无符号），触发陷阱异常":
    "If {rs} ≥ {rt} (unsigned), raise a trap exception",
  "若 {rs} ≥ {imm}（有符号），触发陷阱异常":
    "If {rs} ≥ {imm} (signed), raise a trap exception",
  "若 {rs} ≥ {imm}（立即数符号扩展后按无符号比较），触发陷阱异常":
    "If {rs} ≥ {imm} (immediate sign-extended, then compared unsigned), raise a trap exception",
  "若 {rs} < {rt}（有符号），触发陷阱异常":
    "If {rs} < {rt} (signed), raise a trap exception",
  "若 {rs} < {rt}（无符号），触发陷阱异常":
    "If {rs} < {rt} (unsigned), raise a trap exception",
  "若 {rs} < {imm}（有符号），触发陷阱异常":
    "If {rs} < {imm} (signed), raise a trap exception",
  "若 {rs} < {imm}（立即数符号扩展后按无符号比较），触发陷阱异常":
    "If {rs} < {imm} (immediate sign-extended, then compared unsigned), raise a trap exception",
  "从异常返回：清除 status 的异常级别位，跳到 EPC":
    "Return from exception: clear the exception-level bit in status and jump to EPC",
  "{fd} ← {fs} + {ft}（单精度）":
    "{fd} ← {fs} + {ft} (single precision)",
  "{fd} ← {fs} − {ft}（单精度）":
    "{fd} ← {fs} − {ft} (single precision)",
  "{fd} ← {fs} × {ft}（单精度）":
    "{fd} ← {fs} × {ft} (single precision)",
  "{fd} ← {fs} ÷ {ft}（单精度）":
    "{fd} ← {fs} ÷ {ft} (single precision)",
  "{fd} ← √{fs}（单精度；负数得到 NaN）":
    "{fd} ← √{fs} (single precision; negative values give NaN)",
  "{fd} ← {fs} 向下取整后的 32 位整数（超出范围或 NaN 时得到 2³¹−1）":
    "{fd} ← {fs} rounded down to a 32-bit integer (2³¹−1 when out of range or NaN)",
  "{fd} ← {fs} 向上取整后的 32 位整数（超出范围或 NaN 时得到 2³¹−1）":
    "{fd} ← {fs} rounded up to a 32-bit integer (2³¹−1 when out of range or NaN)",
  "{fd} ← {fs} 四舍六入五取偶后的 32 位整数（超出范围或 NaN 时得到 2³¹−1）":
    "{fd} ← {fs} rounded to the nearest 32-bit integer, ties to even (2³¹−1 when out of range or NaN)",
  "{fd} ← {fs} 向 0 截断后的 32 位整数（超出范围或 NaN 时得到 2³¹−1）":
    "{fd} ← {fs} truncated toward zero to a 32-bit integer (2³¹−1 when out of range or NaN)",
  "{fd} ← {fs} + {ft}（双精度，寄存器成对使用）":
    "{fd} ← {fs} + {ft} (double precision, registers used in pairs)",
  "{fd} ← {fs} − {ft}（双精度，寄存器成对使用）":
    "{fd} ← {fs} − {ft} (double precision, registers used in pairs)",
  "{fd} ← {fs} × {ft}（双精度，寄存器成对使用）":
    "{fd} ← {fs} × {ft} (double precision, registers used in pairs)",
  "{fd} ← {fs} ÷ {ft}（双精度，寄存器成对使用）":
    "{fd} ← {fs} ÷ {ft} (double precision, registers used in pairs)",
  "{fd} ← √{fs}（双精度）":
    "{fd} ← √{fs} (double precision)",
  "若条件标志 0 为真，跳到 {off}":
    "If condition flag 0 is true, branch to {off}",
  "若条件标志 {cc} 为真，跳到 {off}":
    "If condition flag {cc} is true, branch to {off}",
  "若条件标志 0 为假，跳到 {off}":
    "If condition flag 0 is false, branch to {off}",
  "若条件标志 {cc} 为假，跳到 {off}":
    "If condition flag {cc} is false, branch to {off}",
  "条件标志 0 ← ({fs} = {ft})（单精度）":
    "Condition flag 0 ← ({fs} = {ft}) (single precision)",
  "条件标志 {cc} ← ({fs} = {ft})（单精度）":
    "Condition flag {cc} ← ({fs} = {ft}) (single precision)",
  "条件标志 0 ← ({fs} ≤ {ft})（单精度）":
    "Condition flag 0 ← ({fs} ≤ {ft}) (single precision)",
  "条件标志 {cc} ← ({fs} ≤ {ft})（单精度）":
    "Condition flag {cc} ← ({fs} ≤ {ft}) (single precision)",
  "条件标志 0 ← ({fs} < {ft})（单精度）":
    "Condition flag 0 ← ({fs} < {ft}) (single precision)",
  "条件标志 {cc} ← ({fs} < {ft})（单精度）":
    "Condition flag {cc} ← ({fs} < {ft}) (single precision)",
  "条件标志 0 ← ({fs} = {ft})（双精度）":
    "Condition flag 0 ← ({fs} = {ft}) (double precision)",
  "条件标志 {cc} ← ({fs} = {ft})（双精度）":
    "Condition flag {cc} ← ({fs} = {ft}) (double precision)",
  "条件标志 0 ← ({fs} ≤ {ft})（双精度）":
    "Condition flag 0 ← ({fs} ≤ {ft}) (double precision)",
  "条件标志 {cc} ← ({fs} ≤ {ft})（双精度）":
    "Condition flag {cc} ← ({fs} ≤ {ft}) (double precision)",
  "条件标志 0 ← ({fs} < {ft})（双精度）":
    "Condition flag 0 ← ({fs} < {ft}) (double precision)",
  "条件标志 {cc} ← ({fs} < {ft})（双精度）":
    "Condition flag {cc} ← ({fs} < {ft}) (double precision)",
  "{fd} ← |{fs}|（清除符号位）":
    "{fd} ← |{fs}| (clears the sign bit)",
  "{fd} ← |{fs}|（双精度，清除高位寄存器的符号位）":
    "{fd} ← |{fs}| (double precision; clears the sign bit of the high register)",
  "{fd} ← 单精度 {fs} 转成双精度":
    "{fd} ← single-precision {fs} converted to double",
  "{fd} ← {fs} 里的 32 位整数转成双精度":
    "{fd} ← the 32-bit integer in {fs} converted to double",
  "{fd} ← 双精度 {fs} 转成单精度":
    "{fd} ← double-precision {fs} converted to single",
  "{fd} ← {fs} 里的 32 位整数转成单精度":
    "{fd} ← the 32-bit integer in {fs} converted to single",
  "{fd} ← 双精度 {fs} 截断成 32 位整数":
    "{fd} ← double-precision {fs} truncated to a 32-bit integer",
  "{fd} ← 单精度 {fs} 截断成 32 位整数":
    "{fd} ← single-precision {fs} truncated to a 32-bit integer",
  "{fd} ← {fs}（双精度，复制一对寄存器）":
    "{fd} ← {fs} (double precision, copies a register pair)",
  "若条件标志 0 为假，则 {fd} ← {fs}（双精度，复制一对寄存器）":
    "If condition flag 0 is false, {fd} ← {fs} (double precision, copies a register pair)",
  "若条件标志 {cc} 为假，则 {fd} ← {fs}（双精度，复制一对寄存器）":
    "If condition flag {cc} is false, {fd} ← {fs} (double precision, copies a register pair)",
  "若条件标志 0 为真，则 {fd} ← {fs}（双精度，复制一对寄存器）":
    "If condition flag 0 is true, {fd} ← {fs} (double precision, copies a register pair)",
  "若条件标志 {cc} 为真，则 {fd} ← {fs}（双精度，复制一对寄存器）":
    "If condition flag {cc} is true, {fd} ← {fs} (double precision, copies a register pair)",
  "若 {rt} ≠ 0，则 {fd} ← {fs}（双精度，复制一对寄存器）":
    "If {rt} ≠ 0, {fd} ← {fs} (double precision, copies a register pair)",
  "若 {rt} = 0，则 {fd} ← {fs}（双精度，复制一对寄存器）":
    "If {rt} = 0, {fd} ← {fs} (double precision, copies a register pair)",
  "{fd} ← {fs}":
    "{fd} ← {fs}",
  "若条件标志 0 为假，则 {fd} ← {fs}":
    "If condition flag 0 is false, {fd} ← {fs}",
  "若条件标志 {cc} 为假，则 {fd} ← {fs}":
    "If condition flag {cc} is false, {fd} ← {fs}",
  "若条件标志 0 为真，则 {fd} ← {fs}":
    "If condition flag 0 is true, {fd} ← {fs}",
  "若条件标志 {cc} 为真，则 {fd} ← {fs}":
    "If condition flag {cc} is true, {fd} ← {fs}",
  "若 {rt} ≠ 0，则 {fd} ← {fs}":
    "If {rt} ≠ 0, {fd} ← {fs}",
  "若 {rt} = 0，则 {fd} ← {fs}":
    "If {rt} = 0, {fd} ← {fs}",
  "{rt} ← {fs} 的 32 位原始内容（不做转换）":
    "{rt} ← raw 32 bits of {fs} (no conversion)",
  "{fs} ← {rt} 的 32 位原始内容（不做转换）":
    "{fs} ← raw 32 bits of {rt} (no conversion)",
  "{fd} ← −{fs}（双精度，翻转符号位）":
    "{fd} ← −{fs} (double precision; flips the sign bit)",
  "{fd} ← −{fs}（翻转符号位）":
    "{fd} ← −{fs} (flips the sign bit)",
  "{ft} ← 内存[{mem}] 的 4 字节":
    "{ft} ← 4 bytes of memory[{mem}]",
  "{ft} 这一对寄存器 ← 内存[{mem}] 的 8 字节（地址必须是 8 的倍数）":
    "Register pair {ft} ← 8 bytes of memory[{mem}] (address must be a multiple of 8)",
  "内存[{mem}] ← {ft} 的 4 字节":
    "memory[{mem}] ← 4 bytes of {ft}",
  "内存[{mem}] 的 8 字节 ← {ft} 这一对寄存器（地址必须是 8 的倍数）":
    "8 bytes of memory[{mem}] ← register pair {ft} (address must be a multiple of 8)",
}
