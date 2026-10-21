// Neutral entrypoint: no "use client" of its own (individual files under ui/ carry their
// own directive where needed, which is fine to import from a neutral barrel), no
// server-only code. Re-exports every named export of every file under ui/, plus cn().
export { cn } from "@/shared/ui-primitives/core/cn";

export { Button, buttonVariants } from "@/shared/ui-primitives/ui/button";
export { Input } from "@/shared/ui-primitives/ui/input";
export { Label } from "@/shared/ui-primitives/ui/label";
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from "@/shared/ui-primitives/ui/card";
