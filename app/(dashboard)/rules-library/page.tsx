"use client";

import { useState, useEffect, useCallback } from "react";
import { GLOBAL_RULES_DISPLAY, COMMON_LEDGERS } from "@/lib/ledger-rules";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Trash2, Plus, Search, ShieldCheck, Building2, User, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

interface DbRule {
  id: string;
  client_id: string | null;
  industry_name: string | null;
  pattern: string;
  ledger_name: string;
  match_count: number;
  confirmed: boolean;
  updated_at: string;
  clients?: { client_name: string } | null;
}

interface ClientForSelect {
  id: string;
  client_name: string;
}

type LayerTab = "layer1" | "layer2" | "layer3";

export default function RulesLibraryPage() {
  const [activeTab, setActiveTab] = useState<LayerTab>("layer3");
  const [clientRules, setClientRules] = useState<DbRule[]>([]);
  const [industryRules, setIndustryRules] = useState<DbRule[]>([]);
  const [clients, setClients] = useState<ClientForSelect[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Add rule form
  const [addOpen, setAddOpen] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [newLedger, setNewLedger] = useState("");
  const [newClientId, setNewClientId] = useState<string>("");
  const [newScope, setNewScope] = useState<"client" | "industry">("client");
  const [newIndustry, setNewIndustry] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, clientsRes] = await Promise.all([
        fetch("/api/v1/ledger-rules"),
        fetch("/api/v1/clients"),
      ]);
      if (rulesRes.ok) {
        const d = await rulesRes.json();
        setClientRules(d.client_rules ?? []);
        setIndustryRules(d.industry_rules ?? []);
      }
      if (clientsRes.ok) {
        const d = await clientsRes.json();
        setClients(d.clients ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addRule() {
    if (!newPattern.trim() || !newLedger) return;
    setSaving(true);
    try {
      const body: Record<string, string | null> = {
        pattern: newPattern.trim(),
        ledger_name: newLedger,
        client_id: newScope === "client" ? (newClientId || null) : null,
        industry_name: newScope === "industry" ? (newIndustry || null) : null,
      };
      const res = await fetch("/api/v1/ledger-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("Rule added");
        setNewPattern(""); setNewLedger(""); setNewClientId(""); setNewIndustry("");
        setAddOpen(false);
        load();
      } else {
        const d = await res.json();
        toast.error(d.error ?? "Failed to add rule");
      }
    } finally {
      setSaving(false);
    }
  }

  async function deleteRule(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/v1/ledger-rules/${id}`, { method: "DELETE" });
      if (res.ok) { toast.success("Rule deleted"); load(); }
      else toast.error("Failed to delete rule");
    } finally {
      setDeletingId(null);
    }
  }

  const TABS = [
    { id: "layer3" as LayerTab, label: "Client Rules",    icon: User,         count: clientRules.length },
    { id: "layer2" as LayerTab, label: "Industry Rules",  icon: Building2,    count: industryRules.length },
    { id: "layer1" as LayerTab, label: "Global Rules",    icon: ShieldCheck,  count: GLOBAL_RULES_DISPLAY.length },
  ];

  // Filter helpers
  const q = search.toLowerCase();
  const filteredClient   = clientRules.filter(r =>
    r.pattern.includes(q) || r.ledger_name.toLowerCase().includes(q) ||
    (r.clients?.client_name ?? "").toLowerCase().includes(q)
  );
  const filteredIndustry = industryRules.filter(r =>
    r.pattern.includes(q) || r.ledger_name.toLowerCase().includes(q) ||
    (r.industry_name ?? "").toLowerCase().includes(q)
  );
  const filteredGlobal = GLOBAL_RULES_DISPLAY.filter(r =>
    r.ledger.toLowerCase().includes(q) || r.label.toLowerCase().includes(q) || r.examples.toLowerCase().includes(q)
  );

  // Group client rules by client name
  const grouped: Record<string, DbRule[]> = {};
  for (const r of filteredClient) {
    const name = r.clients?.client_name ?? "No Client";
    if (!grouped[name]) grouped[name] = [];
    grouped[name].push(r);
  }

  return (
    <div className="max-w-5xl space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Rules Library</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            All ledger auto-mapping rules — global defaults, industry patterns, and client-specific rules.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(!addOpen)} className="gap-1.5">
          <Plus size={14} />
          Add Rule
        </Button>
      </div>

      {/* Add Rule Form */}
      {addOpen && (
        <div className="border border-blue-200 rounded-lg bg-blue-50 p-4 space-y-3">
          <p className="text-sm font-medium text-blue-800">New Mapping Rule</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600 mb-1 block">Applies to</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setNewScope("client")}
                  className={`px-3 py-1.5 text-xs rounded border transition-colors ${newScope === "client" ? "bg-blue-600 text-white border-blue-600" : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                >
                  Specific Client
                </button>
                <button
                  onClick={() => setNewScope("industry")}
                  className={`px-3 py-1.5 text-xs rounded border transition-colors ${newScope === "industry" ? "bg-blue-600 text-white border-blue-600" : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                >
                  Whole Industry
                </button>
              </div>
            </div>
            <div>
              {newScope === "client" ? (
                <>
                  <label className="text-xs text-gray-600 mb-1 block">Client (optional)</label>
                  <select
                    value={newClientId}
                    onChange={e => setNewClientId(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
                  >
                    <option value="">All clients</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>{c.client_name}</option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label className="text-xs text-gray-600 mb-1 block">Industry name</label>
                  <Input
                    placeholder="e.g. Manufacturing"
                    value={newIndustry}
                    onChange={e => setNewIndustry(e.target.value)}
                    className="text-sm"
                  />
                </>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600 mb-1 block">Narration keyword / pattern</label>
              <Input
                placeholder="e.g. jio services, mseb, salary"
                value={newPattern}
                onChange={e => setNewPattern(e.target.value)}
                className="text-sm"
              />
              <p className="text-xs text-gray-400 mt-1">Lowercase, partial match — e.g. "jio" matches any narration containing "jio"</p>
            </div>
            <div>
              <label className="text-xs text-gray-600 mb-1 block">Ledger name</label>
              <Input
                list="ledger-suggestions"
                placeholder="e.g. Food Expenses, Rent…"
                value={newLedger}
                onChange={e => setNewLedger(e.target.value)}
                className="text-sm"
              />
              <datalist id="ledger-suggestions">
                {COMMON_LEDGERS.map(l => (
                  <option key={l.ledger_name} value={l.ledger_name} />
                ))}
              </datalist>
              <p className="text-xs text-gray-400 mt-1">Pick from suggestions or type a custom name</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={addRule} disabled={saving || !newPattern.trim() || !newLedger}>
              {saving ? <Loader2 size={13} className="animate-spin mr-1" /> : null}
              Save Rule
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* How it works callout */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-800 space-y-1">
        <p className="font-medium">How auto-mapping works (3 layers, first match wins)</p>
        <ol className="list-decimal list-inside space-y-0.5 text-blue-700 text-xs">
          <li><strong>Client Rules</strong> — highest priority. Created automatically when you assign a ledger 3+ times to the same narration pattern.</li>
          <li><strong>Industry Rules</strong> — promoted automatically when 3+ of your clients in the same industry confirm the same mapping.</li>
          <li><strong>Global Rules</strong> — 18 built-in keyword rules (JIO, SALARY, AIRTEL, EPFO, etc.) that apply to every client. These handle the most common cases out of the box.</li>
        </ol>
        <p className="text-xs text-blue-600 pt-1">
          Narrations like <code className="bg-blue-100 px-1 rounded">UPI/VENDOR NAME/12345/UPI</code> where the vendor is unknown will not auto-map — assign the ledger once and the system learns the pattern for next time.
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input
          placeholder="Search pattern, ledger, client…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8 text-sm"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab.id
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            <tab.icon size={13} />
            {tab.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-normal ${
              activeTab === tab.id ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"
            }`}>
              {tab.id === "layer1" ? GLOBAL_RULES_DISPLAY.length : tab.count}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-400 py-8">
          <Loader2 size={16} className="animate-spin" /> Loading rules…
        </div>
      ) : (
        <>
          {/* ── LAYER 3 — Client Rules ── */}
          {activeTab === "layer3" && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500">
                Learned from confirmed ledger assignments per client.
                A rule becomes <strong>confirmed</strong> after 3 matches.
                Priority: these rules override industry and global rules.
              </p>
              {Object.keys(grouped).length === 0 ? (
                <EmptyState message="No client-specific rules yet. They are created automatically as you assign ledgers to bank transactions." />
              ) : (
                Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([clientName, rules]) => (
                  <ClientGroup key={clientName} clientName={clientName} rules={rules} deletingId={deletingId} onDelete={deleteRule} />
                ))
              )}
            </div>
          )}

          {/* ── LAYER 2 — Industry Rules ── */}
          {activeTab === "layer2" && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                Auto-promoted when 3+ clients in the same industry confirm the same pattern → ledger mapping.
                Applied to all new clients in that industry automatically.
              </p>
              {filteredIndustry.length === 0 ? (
                <EmptyState message="No industry rules yet. They appear automatically when enough clients in the same industry confirm a pattern." />
              ) : (
                <RulesTable rules={filteredIndustry} showCol="industry" deletingId={deletingId} onDelete={deleteRule} />
              )}
            </div>
          )}

          {/* ── LAYER 1 — Global Rules ── */}
          {activeTab === "layer1" && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                Built into the system code — apply to every client automatically. Read-only. These cover common
                Indian business keywords (JIO, AIRTEL, SALARY, EPFO etc.) and map them to standard ledgers.
              </p>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-left">
                    <th className="px-3 py-2 font-medium text-gray-600 border-b text-xs">Category</th>
                    <th className="px-3 py-2 font-medium text-gray-600 border-b text-xs">Keywords / Vendors matched</th>
                    <th className="px-3 py-2 font-medium text-gray-600 border-b text-xs">Maps to Ledger</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGlobal.map((r, i) => (
                    <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2.5 font-medium text-gray-800 text-sm whitespace-nowrap">{r.label}</td>
                      <td className="px-3 py-2.5 text-gray-500 text-xs max-w-xs">{r.examples}</td>
                      <td className="px-3 py-2.5">
                        <span className="inline-block bg-green-50 text-green-700 border border-green-200 text-xs px-2 py-0.5 rounded">
                          {r.ledger}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ClientGroup({ clientName, rules, deletingId, onDelete }: {
  clientName: string;
  rules: DbRule[];
  deletingId: string | null;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const confirmed = rules.filter(r => r.confirmed).length;
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          <User size={13} className="text-gray-400" />
          <span className="text-sm font-medium text-gray-800">{clientName}</span>
          <span className="text-xs text-gray-400">{rules.length} rule{rules.length !== 1 ? "s" : ""}</span>
          {confirmed > 0 && (
            <Badge variant="secondary" className="text-xs bg-green-50 text-green-700 border-green-200">
              {confirmed} confirmed
            </Badge>
          )}
        </div>
        {open ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
      </button>
      {open && (
        <RulesTable rules={rules} showCol="none" deletingId={deletingId} onDelete={onDelete} />
      )}
    </div>
  );
}

function RulesTable({ rules, showCol, deletingId, onDelete }: {
  rules: DbRule[];
  showCol: "industry" | "client" | "none";
  deletingId: string | null;
  onDelete: (id: string) => void;
}) {
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="bg-gray-50 text-left">
          {showCol === "industry" && <th className="px-3 py-2 font-medium text-gray-600 border-b text-xs">Industry</th>}
          {showCol === "client"   && <th className="px-3 py-2 font-medium text-gray-600 border-b text-xs">Client</th>}
          <th className="px-3 py-2 font-medium text-gray-600 border-b text-xs">Pattern (narration keyword)</th>
          <th className="px-3 py-2 font-medium text-gray-600 border-b text-xs">Maps to Ledger</th>
          <th className="px-3 py-2 font-medium text-gray-600 border-b text-xs">Matches</th>
          <th className="px-3 py-2 font-medium text-gray-600 border-b text-xs">Status</th>
          <th className="px-3 py-2 border-b" />
        </tr>
      </thead>
      <tbody>
        {rules.map(r => (
          <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
            {showCol === "industry" && <td className="px-3 py-2.5 text-gray-600 text-xs">{r.industry_name}</td>}
            {showCol === "client"   && <td className="px-3 py-2.5 text-gray-600 text-xs">{r.clients?.client_name ?? "—"}</td>}
            <td className="px-3 py-2.5">
              <code className="text-xs bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded font-mono">{r.pattern}</code>
            </td>
            <td className="px-3 py-2.5">
              <span className="inline-block bg-green-50 text-green-700 border border-green-200 text-xs px-2 py-0.5 rounded">
                {r.ledger_name}
              </span>
            </td>
            <td className="px-3 py-2.5 text-gray-500 text-xs">{r.match_count}×</td>
            <td className="px-3 py-2.5">
              {r.confirmed
                ? <Badge variant="secondary" className="text-xs bg-green-50 text-green-700 border-green-200">Confirmed</Badge>
                : <Badge variant="secondary" className="text-xs bg-amber-50 text-amber-700 border-amber-200">Learning ({r.match_count}/3)</Badge>
              }
            </td>
            <td className="px-3 py-2.5">
              <button
                onClick={() => onDelete(r.id)}
                disabled={deletingId === r.id}
                className="text-gray-300 hover:text-red-500 transition-colors disabled:opacity-50"
                title="Delete rule"
              >
                {deletingId === r.id
                  ? <Loader2 size={13} className="animate-spin" />
                  : <Trash2 size={13} />
                }
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-12 text-gray-400 text-sm border border-dashed border-gray-200 rounded-lg">
      {message}
    </div>
  );
}
