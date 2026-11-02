import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";

export function Alert({ kind, children }: { kind: "error" | "success"; children: ReactNode }) {
  const Icon = kind === "error" ? AlertCircle : CheckCircle2;
  return (
    <div className={`alert alert--${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden />
      <span>{children}</span>
    </div>
  );
}
