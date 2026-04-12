import AdminGuard from "./AdminGuard";
import Link from "next/link";
import { LayoutDashboard, Building2, BarChart3, Brain, DollarSign, LogOut, SlidersHorizontal } from "lucide-react";

const navItems = [
  { href: "/admin/tenants",   label: "Firms",         icon: Building2 },
  { href: "/admin/usage",     label: "Usage",         icon: BarChart3 },
  { href: "/admin/costs",     label: "AI Costs",      icon: DollarSign },
  { href: "/admin/knowledge", label: "Knowledge",     icon: Brain },
  { href: "/admin/ai-config", label: "AI Config",     icon: SlidersHorizontal },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {

  return (
    <AdminGuard>
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 flex flex-col flex-shrink-0">
        <div className="px-4 py-5 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="w-5 h-5 text-blue-400" />
            <span className="text-white font-semibold text-sm">LedgerIQ Admin</span>
          </div>
          <p className="text-gray-400 text-xs mt-1">Super admin</p>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="px-2 py-4 border-t border-gray-700">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Exit admin
          </Link>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-8">
        {children}
      </main>
    </div>
    </AdminGuard>
  );
}
