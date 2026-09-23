import { auth } from "@/auth";
import { redirect } from "next/navigation";
import ChatApp from "./components/ChatApp";

export default async function Home() {
  const session = await auth();
  if (!session) redirect("/signin");
  return <ChatApp />;
}