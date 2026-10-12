import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requireUser();
  redirect("/calendar");
}
