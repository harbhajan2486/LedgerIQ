"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Users, Plug, BookOpen, Download, Loader2, CheckCircle2,
  XCircle, Trash2, UserPlus, Settings2, CreditCard
} from "lucide-react";

const STANDARD_ACCOUNTS = [
  { key: "purchase_account",  label: "Purchase Account" },
  { key: "input_igst_18",     label: "Input IGST 18%" },
  { key: "input_igst_12",     label: "Input IGST 12%" },
  { key: "input_igst_5",      label: "Input IGST 5%" },
  { key: "input_cgst",        label: "Input CGST" },
  { key: "input_sgst",        label: "Input SGST" },
  { key: "sundry_creditors",  label: "Sundry Creditors" },
  { key: "tds_payable",       label: "TDS Payable" },
];

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  senior_reviewer: "Senior Reviewer",
  reviewer: "Reviewer",
};

interface TeamMember {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  created_at: string;
}

type Tab = "team" | "tally" | "subscription";

export default function SettingsPage() {
  const supabase = createClient();
  const [activeTab, setActiveTab] = useState<Tab>("team");

  // ---------- TEAM ----------
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [teamLoading, setTeamLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("reviewer");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // ---------- TALLY ----------
  const [tallyEndpoint, setTallyEndpoint] = useState("http://localhost:9000");
  const [tallyCompany, setTallyCompany] = useState("");
  const [savingTally, setSavingTally] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tallyStatus, setTallyStatus] = useState<"idle" | "success" | "error">("idle");
  const [tallyMsg, setTallyMsg] = useState<string | null>(null);
  const [ledgerMap, setLedgerMap] = useState<Record<string, string>>(
    Object.fromEntries(STANDARD_ACCOUNTS.map((a) => [a.key, ""]))
  );
  const [savingLedger, setSavingLedger] = useState(false);
  const [ledgerMsg, setLedgerMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // ---------- AUDIT LOG ----------
  const [downloadingAudit, setDownloadingAudit] = useState(false);

  const loadTeam = useCallback(async () => {
    setTeamLoading(true);
    try {
      const res = await fetch("/api/v1/settings/team");
      if (res.ok) {
        const data = await res.json();
        setTeam(data.members ?? []);
      }
    } finally {
      setTeamLoading(false);
    }
  }, []);

  const loadTallySettings = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) setCurrentUserId(user.id);

    const res = await fetch("/api/v1/settings/tally");
    if (res.ok) {
      const data = await res.json();
      if (data.endpoint) setTallyEndpoint(data.endpoint);
      if (data.company) setTallyCompany(data.company);
    }
    const resLedger = await fetch("/api/v1/settings/ledger-mapping");
    if (resLedger.ok) {
      const data = await resLedger.json();
      if (data.mappings) {
        const map: Record<string, string> = { ...ledgerMap };
        for (const m of data.mappings) map[m.standard_account] = m.tally_ledger_name;
        setLedgerMap(map);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadTeam();
    loadTallySettings();
  }, [loadTeam, loadTallySettings]);

  // ---- Invite user ----
  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteMsg(null);
    try {
      const res = await fetch("/api/v1/settings/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const data = await res.json();
      if (res.ok) {
        setInviteMsg({ type: "success", text: "Invitation sent! They'll get an email to set up their account." });
        setInviteEmail("");
        loadTeam();
      } else {
        setInviteMsg({ type: "error", text: data.error ?? "Failed to invite user." });
      }
    } catch {
      setInviteMsg({ type: "error", text: "Network error. Please try again." });
    } finally {
      setInviting(false);
    }
  }

  // ---- Remove user ----
  async function handleRemove(userId: string) {
    if (!confirm("Remove this team member? They will lose access immediately.")) return;
    setRemovingId(userId);
    try {
      await fetch(`/api/v1/settings/team/${userId}`, { method: "DELETE" });
      setTeam((prev) => prev.filter((m) => m.id !== userId));
    } finally {
      setRemovingId(null);
    }
  }

  // ---- Test Tally ----
  async function testTally() {
    setTesting(true);
    setTallyStatus("idle");
    try {
      const res = await fetch("/api/v1/tally/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: tallyEndpoint }),
      });
      setTallyStatus(res.ok ? "success" : "error");
    } catch {
      setTallyStatus("error");
    } finally {
      setTesting(false);
    }
  }

  // ---- Save Tally config ----
  async function saveTally(e: React.FormEvent) {
    e.preventDefault();
    setSavingTally(true);
    setTallyMsg(null);
    try {
      const res = await fetch("/api/v1/settings/tally", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: tallyEndpoint, company: tallyCompany }),
      });
      setTallyMsg(res.ok ? "Tally settings saved." : "Failed to save.");
    } catch {
      setTallyMsg("Network error.");
    } finally {
      setSavingTally(false);
    }
  }

  // ---- Save ledger mapping ----
  async function saveLedger(e: React.FormEvent) {
    e.preventDefault();
    setSavingLedger(true);
    setLedgerMsg(null);
    try {
      const res = await fetch("/api/v1/settings/ledger-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings: ledgerMap }),
      });
      setLedgerMsg(res.ok
        ? { type: "success", text: "Ledger mappings saved." }
        : { type: "error", text: "Failed to save mappings." }
      );
    } catch {
      setLedgerMsg({ type: "error", text: "Network error." });
    } finally {
      setSavingLedger(false);
    }
  }

  // ---- Download audit log ----
  async function downloadAuditLog() {
    setDownloadingAudit(true);
    try {
      const res = await fetch("/api/v1/settings/audit-log");
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setDownloadingAudit(false);
    }
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "team", label: "Team", icon: <Users className="w-4 h-4" /> },
    { id: "tally", label: "Tally & Ledgers", icon: <Plug className="w-4 h-4" /> },
    { id: "subscription", label: "Subscription", icon: <CreditCard className="w-4 h-4" /> },
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
          <Settings2 className="w-6 h-6" /> Settings
        </h1>
        <p className="text-sm text-gray-500 mt-1">Manage your firm, team, and integrations.</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* ======================== TEAM TAB ======================== */}
      {activeTab === "team" && (
        <div className="space-y-6">
          {/* Invite */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <UserPlus className="w-4 h-4" /> Invite team member
              </CardTitle>
              <CardDescription>
                Invite staff to review documents. They&apos;ll receive an email with login instructions.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleInvite} className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1">
                  <Label htmlFor="invite-email">Email address</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    placeholder="colleague@yourfirm.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="invite-role">Role</Label>
                  <select
                    id="invite-role"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="reviewer">Reviewer</option>
                    <option value="senior_reviewer">Senior Reviewer</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <Button type="submit" disabled={inviting}>
                  {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send invite"}
                </Button>
              </form>
              {inviteMsg && (
                <p className={`mt-3 text-sm ${inviteMsg.type === "success" ? "text-green-600" : "text-red-600"}`}>
                  {inviteMsg.text}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Team list */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="w-4 h-4" /> Team members
              </CardTitle>
            </CardHeader>
            <CardContent>
              {teamLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : team.length === 0 ? (
                <p className="text-sm text-gray-500">No team members yet. Invite someone above.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {team.map((member) => (
                    <div key={member.id} className="flex items-center justify-between py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {member.full_name || member.email}
                        </p>
                        {member.full_name && (
                          <p className="text-xs text-gray-500">{member.email}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant="secondary">{ROLE_LABELS[member.role] ?? member.role}</Badge>
                        {member.id !== currentUserId && (
                          <button
                            onClick={() => handleRemove(member.id)}
                            disabled={removingId === member.id}
                            className="text-gray-400 hover:text-red-500 transition-colors"
                            title="Remove member"
                          >
                            {removingId === member.id
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <Trash2 className="w-4 h-4" />
                            }
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Audit log */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BookOpen className="w-4 h-4" /> Audit log
              </CardTitle>
              <CardDescription>
                Download a full log of all actions taken in your account (CSV format).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={downloadAuditLog} disabled={downloadingAudit}>
                {downloadingAudit
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Preparing...</>
                  : <><Download className="w-4 h-4 mr-2" /> Download audit log</>
                }
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ======================== TALLY TAB ======================== */}
      {activeTab === "tally" && (
        <div className="space-y-6">
          {/* Tally connection */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Plug className="w-4 h-4" /> Tally connection
              </CardTitle>
              <CardDescription>
                Tally must be open and running on your computer. The default port is 9000.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveTally} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="tally-endpoint">Tally URL</Label>
                    <div className="flex gap-2">
                      <Input
                        id="tally-endpoint"
                        value={tallyEndpoint}
                        onChange={(e) => setTallyEndpoint(e.target.value)}
                        placeholder="http://localhost:9000"
                      />
                      <Button type="button" variant="outline" onClick={testTally} disabled={testing}>
                        {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Test"}
                      </Button>
                    </div>
                    {tallyStatus === "success" && (
                      <p className="text-xs text-green-600 flex items-center gap-1 mt-1">
                        <CheckCircle2 className="w-3 h-3" /> Connected
                      </p>
                    )}
                    {tallyStatus === "error" && (
                      <p className="text-xs text-red-600 flex items-center gap-1 mt-1">
                        <XCircle className="w-3 h-3" /> Cannot connect — make sure TallyPrime is open
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tally-company">Company name in Tally</Label>
                    <Input
                      id="tally-company"
                      value={tallyCompany}
                      onChange={(e) => setTallyCompany(e.target.value)}
                      placeholder="ABC Pvt Ltd"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={savingTally}>
                    {savingTally ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                  </Button>
                  {tallyMsg && <p className="text-sm text-green-600">{tallyMsg}</p>}
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Ledger mapping */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BookOpen className="w-4 h-4" /> Ledger name mapping
              </CardTitle>
              <CardDescription>
                Map each account type to the exact ledger name used in your Tally company.
                This is how LedgerIQ knows where to post each invoice line.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveLedger} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {STANDARD_ACCOUNTS.map((account) => (
                    <div key={account.key} className="space-y-1">
                      <Label htmlFor={`ledger-${account.key}`}>{account.label}</Label>
                      <Input
                        id={`ledger-${account.key}`}
                        value={ledgerMap[account.key] ?? ""}
                        onChange={(e) => setLedgerMap((prev) => ({ ...prev, [account.key]: e.target.value }))}
                        placeholder={`e.g. ${account.label}`}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={savingLedger}>
                    {savingLedger ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save mappings"}
                  </Button>
                  {ledgerMsg && (
                    <p className={`text-sm ${ledgerMsg.type === "success" ? "text-green-600" : "text-red-600"}`}>
                      {ledgerMsg.text}
                    </p>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ======================== SUBSCRIPTION TAB ======================== */}
      {activeTab === "subscription" && (
        <SubscriptionTab />
      )}
    </div>
  );
}

function SubscriptionTab() {
  const [info, setInfo] = useState<{
    plan: string;
    status: string;
    current_period_end: string | null;
    docs_this_month: number;
    ai_spend_this_month: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/billing/info")
      .then((r) => r.json())
      .then(setInfo)
      .finally(() => setLoading(false));
  }, []);

  const PLAN_LABELS: Record<string, string> = {
    starter: "Starter",
    pro: "Pro",
    business: "Business",
    enterprise: "Enterprise",
    free: "Free (beta)",
  };

  const STATUS_COLORS: Record<string, string> = {
    active: "bg-green-100 text-green-800",
    trialing: "bg-blue-100 text-blue-800",
    past_due: "bg-yellow-100 text-yellow-800",
    canceled: "bg-red-100 text-red-800",
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading subscription info...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="w-4 h-4" /> Current plan
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold text-gray-900">
              {PLAN_LABELS[info?.plan ?? "free"] ?? info?.plan}
            </span>
            {info?.status && (
              <span className={`text-xs font-medium px-2 py-1 rounded-full capitalize ${STATUS_COLORS[info.status] ?? "bg-gray-100 text-gray-700"}`}>
                {info.status}
              </span>
            )}
          </div>

          {info?.current_period_end && (
            <p className="text-sm text-gray-500">
              Renews on {new Date(info.current_period_end).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
            </p>
          )}

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-1">Documents this month</p>
              <p className="text-xl font-semibold text-gray-900">{info?.docs_this_month ?? 0}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-1">AI spend this month</p>
              <p className="text-xl font-semibold text-gray-900">
                ${(info?.ai_spend_this_month ?? 0).toFixed(2)}
                <span className="text-sm text-gray-400 ml-1">/ $50 limit</span>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Manage subscription</CardTitle>
          <CardDescription>
            Upgrade, downgrade, or cancel your plan. Changes take effect at the next billing cycle.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            onClick={async () => {
              const res = await fetch("/api/v1/billing/portal", { method: "POST" });
              const data = await res.json();
              if (data.url) window.location.href = data.url;
            }}
          >
            Manage billing &amp; invoices
          </Button>
          <p className="text-xs text-gray-400">
            You&apos;ll be taken to a secure Stripe billing page. Your payment details are never stored in LedgerIQ.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
