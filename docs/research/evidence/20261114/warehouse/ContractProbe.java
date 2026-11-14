import java.nio.file.Path;
import org.zhejianglab.astro.atlas.scanner.ScanPlanLoader;
import org.zhejianglab.astro.atlas.core.ScanPlanValidator;
public class ContractProbe {
 public static void main(String[] args) throws Exception {
  for(String name:args) {
   boolean accepted=false;
   try { var p=new ScanPlanLoader().load(Path.of(name)); ScanPlanValidator.validate(p,true); accepted=true; System.out.println(Path.of(name).getFileName()+": ACCEPTED (parse/validate only, no I/O)"); }
   catch(Exception e) {System.out.println(Path.of(name).getFileName()+": REJECTED "+e.getClass().getSimpleName()+" "+e.getMessage().split("\n")[0]);}
   if(accepted!=Path.of(name).getFileName().toString().equals("valid.json"))throw new AssertionError("unexpected contract result "+name);
  }
 }
}
