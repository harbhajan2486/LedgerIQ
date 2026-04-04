import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // API routes handle their own auth — never intercept
  if (pathname.startsWith("/api/")) return NextResponse.next();

  // Public routes — always allow
  const publicPaths = ["/login", "/signup", "/auth/callback", "/auth/reset-password"];
  const isPublic = publicPaths.some((p) => pathname.startsWith(p));
  if (isPublic) return NextResponse.next();

  // For all other routes, check auth — but never crash if Supabase is unreachable
  let user = null;
  let supabaseResponse = NextResponse.next({ request });

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            );
            supabaseResponse = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            );
          },
        },
      }
    );

    const { data, error: authError } = await supabase.auth.getUser();
    // If auth check errors (network issue), fail open — each layout handles its own auth
    if (!authError) user = data.user;
  } catch {
    return NextResponse.next();
  }

  // Admin routes — layout handles role check; proxy only guards unauthenticated access
  // If auth check failed (user still null), let the admin layout handle it
  if (pathname.startsWith("/admin")) {
    return supabaseResponse;
  }

  // Protected routes — redirect to login if definitely not authenticated
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect logged-in users away from login
  if (pathname === "/login" && user) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
