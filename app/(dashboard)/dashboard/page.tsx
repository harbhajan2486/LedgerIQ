export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  ClipboardCheck,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Building2,
} from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { DemoTour } from "@/components/demo/DemoTour";

async function getDashboardStats(tenantId: string) {
  try {
    const supabase = await createClient();
    const today = new Date().toISOString().split("T")[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      { count: todayDocs },
      { count: pendingReview },
      { count: matchedThisWeek },
      { count: exceptions },
      { data: recentActivity },
    ] = await Promise.all([
      supabase
        .from("documents")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("uploaded_at", today),
      supabase
        .from("documents")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "review_required"),
      supabase
        .from("reconciliations")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "matched")
        .gte("matched_at", weekAgo),
      supabase
        .from("reconciliations")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "exception"),
      supabase
        .from("audit_log")
        .select("action, entity_type, timestamp, user_id")
        .eq("tenant_id", tenantId)
        .order("timestamp", { ascending: false })
        .limit(10),
    ]);

    return {
      todayDocs: todayDocs ?? 0,
      pendingReview: pendingReview ?? 0,
      matchedThisWeek: matchedThisWeek ?? 0,
      exceptions: exceptions ?? 0,
      recentActivity: recentActivity ?? [],
    };
  } catch (e) {
    console.error("[dashboard] getDashboardStats error:", e);
    return { todayDocs: 0, pendingReview: 0, matchedThisWeek: 0, exceptions: 0, recentActivity: [] };
  }
}

export default async function DashboardPage() {
  let user = null;
  let userProfile = null;

  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    user = session?.user ?? null;

    if (user) {
      const { data } = await supabase
        .from("users")
        .select("tenant_id, role")
        .eq("id", user.id)
        .single();
      userProfile = data;
    }
  } catch (e) {
    console.error("[dashboard] auth/profile error:", e);
  }

  if (!user) {
    return (
      <div style={{ padding: "2rem" }}>
        <p>Not authenticated — please <a href="/login">log in</a></p>
      </div>
    );
  }

  const stats = userProfile?.tenant_id
    ? await getDashboardStats(userProfile.tenant_id)
    : null;

  const isEmpty = !stats || (stats.todayDocs === 0 && stats.pendingReview === 0);

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Welcome back. Here's what's happening today.</p>
        </div>
        <DemoTour />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Processed Today" value={stats?.todayDocs ?? 0} icon={<FileText size={18} className="text-blue-500" />} href="/clients" emptyHint="Go to Clients to upload" />
        <StatCard title="Pending Review" value={stats?.pendingReview ?? 0} icon={<ClipboardCheck size={18} className="text-amber-500" />} href="/review" badge={stats?.pendingReview ? { label: "Action needed", variant: "destructive" } : undefined} />
        <StatCard title="Matched This Week" value={stats?.matchedThisWeek ?? 0} icon={<CheckCircle2 size={18} className="text-green-500" />} href="/reconciliation" />
        <StatCard title="Exceptions" value={stats?.exceptions ?? 0} icon={<AlertTriangle size={18} className="text-red-500" />} href="/reconciliation" badge={stats?.exceptions ? { label: "Review needed", variant: "destructive" } : undefined} />
      </div>

      {isEmpty && (
        <Card className="border-dashed border-2 border-gray-200">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mb-4">
              <Building2 size={24} className="text-blue-500" />
            </div>
            <h3 className="text-base font-medium text-gray-900 mb-1">Get started with a client</h3>
            <p className="text-sm text-gray-500 max-w-sm mb-6">
              Add a client, then upload their invoices and bank statements. LedgerIQ will read them, map GST and TDS, and match to bank transactions automatically.
            </p>
            <div className="flex gap-3">
              <Link href="/clients" className={buttonVariants()}>Go to Clients</Link>
              <Link href="/settings" className={buttonVariants({ variant: "outline" })}>Configure Tally</Link>
            </div>
          </CardContent>
        </Card>
      )}

      {!isEmpty && stats && stats.recentActivity.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock size={16} className="text-gray-400" />
              Recent activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {stats.recentActivity.map((item, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
                  <span className="text-gray-700 capitalize">{item.action.replace(/_/g, " ")} — {item.entity_type}</span>
                  <span className="text-gray-400 text-xs">
                    {new Date(item.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-3">
        <Link href="/clients" className={buttonVariants()}>
          <Building2 size={16} className="mr-2" />
          Go to Clients
        </Link>
        <Link href="/review" className={buttonVariants({ variant: "outline" })}>Go to Inbox</Link>
      </div>
    </div>
  );
}

function StatCard({
  title, value, icon, href, badge, emptyHint,
}: {
  title: string; value: number; icon: React.ReactNode; href: string;
  badge?: { label: string; variant: "destructive" | "secondary" }; emptyHint?: string;
}) {
  return (
    <Link href={href}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
        <CardContent className="pt-5 pb-4">
          <div className="flex items-start justify-between mb-3">
            <span className="text-sm text-gray-500">{title}</span>
            {icon}
          </div>
          <div className="flex items-end gap-2">
            <span className="text-3xl font-bold text-gray-900">{value}</span>
            {badge && value > 0 && <Badge variant={badge.variant} className="mb-1 text-xs">{badge.label}</Badge>}
          </div>
          {value === 0 && emptyHint && <p className="text-xs text-blue-500 mt-1">{emptyHint}</p>}
        </CardContent>
      </Card>
    </Link>
  );
}
