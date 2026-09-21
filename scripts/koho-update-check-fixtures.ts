/** Completely fictional update tables; protect only newly created test directories. */
import { execFileSync } from "node:child_process";
import { chmod } from "node:fs/promises";
import { DISTRIBUTION_HEADERS } from "../src/lib/koho-distribution-table";

export function updateTable(type: "JPA" | "JPB", dates = ["20990311", "20990318", "20990325", "20990401"]) {
  return DISTRIBUTION_HEADERS[type].join(",") + "\n" + dates.map((date, i) => [date, String(i + 1).padStart(3, "0"),
    String(i + 1).padStart(5, "0"), ...(type === "JPA" ? ["", "", "", "", "00001", "00000"] : ["", "", "20990301", "", "", "00001"]),
    i === 2 ? "不可" : "可", "完全架空"].join(",")).join("\n") + "\n";
}
export async function protectUpdateTestDirectory(directory: string) {
  if (process.platform !== "win32") { await chmod(directory, 0o700); return; }
  const script = `$p=[Console]::In.ReadToEnd();
    $acl=New-Object System.Security.AccessControl.DirectorySecurity;
    $acl.SetAccessRuleProtection($true,$false);
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $acl.SetOwner($sid);
    foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule(
        (New-Object System.Security.Principal.SecurityIdentifier($id)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow');
      $acl.AddAccessRule($rule);
    }
    [System.IO.Directory]::SetAccessControl($p,$acl);
    $check=[System.IO.Directory]::GetAccessControl($p);
    if(-not $check.AreAccessRulesProtected -or $check.Owner -ne $acl.Owner){exit 1}
    foreach($r in $check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
      if($r.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')){exit 1}
    }`;
  try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 15_000 }); }
  catch { throw Error("fictional_private_directory_setup_failed"); }
}
