// Dev-only: prints every instruction form MARS 4.5 knows, one JSON object per line.
// Used to build test fixtures; nothing here ships with the site.
import java.util.ArrayList;
import mars.Globals;
import mars.mips.instructions.BasicInstruction;
import mars.mips.instructions.ExtendedInstruction;
import mars.mips.instructions.Instruction;

public class DumpInstructions {
  static String q(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c == '\n') b.append("\\n");
      else if (c == '\t') b.append("\\t");
      else if (c < 32) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }
  static String list(ArrayList<?> l) {
    if (l == null) return "null";
    StringBuilder b = new StringBuilder("[");
    for (int i = 0; i < l.size(); i++) { if (i > 0) b.append(','); b.append(q(String.valueOf(l.get(i)))); }
    return b.append(']').toString();
  }
  public static void main(String[] args) {
    Globals.initialize(false);
    for (Object o : Globals.instructionSet.getInstructionList()) {
      Instruction ins = (Instruction) o;
      StringBuilder b = new StringBuilder("{");
      b.append("\"name\":").append(q(ins.getName()));
      b.append(",\"example\":").append(q(ins.getExampleFormat()));
      b.append(",\"description\":").append(q(ins.getDescription()));
      if (ins instanceof BasicInstruction) {
        BasicInstruction bi = (BasicInstruction) ins;
        b.append(",\"kind\":\"basic\",\"mask\":").append(q(bi.getOperationMask()));
        b.append(",\"format\":").append(q(String.valueOf(bi.getInstructionFormat())));
      } else {
        ExtendedInstruction ei = (ExtendedInstruction) ins;
        b.append(",\"kind\":\"pseudo\",\"templates\":").append(list(ei.getBasicIntructionTemplateList()));
        b.append(",\"compact\":").append(ei.hasCompactTranslation() ? list(ei.getCompactBasicIntructionTemplateList()) : "null");
      }
      System.out.println(b.append('}'));
    }
  }
}
