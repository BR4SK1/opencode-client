export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|signin|_next/static|_next/image|favicon.ico|icons).*)"],
};