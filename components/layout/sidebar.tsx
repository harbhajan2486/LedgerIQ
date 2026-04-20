"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Upload,
  ClipboardCheck,
  GitMerge,
  FileText,
  BookOpen,
  Settings,
  LogOut,
  Loader2,
  Building2,
  Library,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const navItems = [
  { label: "Dashboard",      href: "/dashboard",       icon: LayoutDashboard },
  { label: "Clients",        href: "/clients",         icon: Building2 },
  { label: "Upload",         href: "/upload",          icon: Upload },
  { label: "Review Queue",   href: "/review",          icon: ClipboardCheck },
  { label: "Reconciliation", href: "/reconciliation",  icon: GitMerge },
  { label: "Post to Tally",  href: "/tally",           icon: BookOpen },
  { label: "Tax Summary",    href: "/tax-summary",     icon: FileText },
  { label: "Rules Library",  href: "/rules-library",   icon: Library },
  { label: "Settings",       href: "/settings",        icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex flex-col w-60 min-h-screen bg-gray-900 text-gray-100 fixed left-0 top-0 z-40">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-gray-800">
        <div className="w-7 h-7 bg-blue-500 rounded-md flex items-center justify-center flex-shrink-0">
          <span className="text-white font-bold text-xs">LQ</span>
        </div>
        <span className="font-semibold text-white text-base">LedgerIQ</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5" aria-label="Main navigation">
        {navItems.map(({ label, href, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                active
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-100"
              )}
            >
              <Icon size={16} className="flex-shrink-0" aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="px-3 py-4 border-t border-gray-800">
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          aria-label="Sign out of LedgerIQ"
          className="flex items-center gap-3 px-3 py-2 w-full rounded-md text-sm text-gray-400 hover:bg-gray-800 hover:text-gray-100 transition-colors"
        >
          {loggingOut
            ? <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            : <LogOut size={16} aria-hidden="true" />
          }
          Sign out
        </button>
      </div>
    </aside>
  );
}
