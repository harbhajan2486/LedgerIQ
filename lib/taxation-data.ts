// Static reference data for the Taxation Rules tab.
// Source: Income Tax Act 1961, CGST Act 2017, GST rate notifications.
// These are statutory rates — not fetched from DB.

export interface TdsSectionRow {
  section: string;
  description: string;
  rate_individual: number | string;
  rate_company: number | string;
  threshold: string;
  notes: string;
}

export interface HsnRow {
  hsn_prefix: string;
  description: string;
  cgst_rate: number;
  sgst_rate: number;
  igst_rate: number;
  exempt: boolean;
}

export interface SacRow {
  sac: string;
  description: string;
  cgst_rate: number;
  sgst_rate: number;
  igst_rate: number;
}

export interface RcmRow {
  service: string;
  sac: string;
  rate: number;
  notes: string;
  notification: string;
}

export interface ItcRow {
  category: string;
  itc_allowed: boolean;
  reason: string;
}

// ─── TDS Sections (Income Tax Act 1961) ──────────────────────────────────────

export const TDS_SECTIONS: TdsSectionRow[] = [
  {
    section: "192",
    description: "Salary",
    rate_individual: "Per slab",
    rate_company: "—",
    threshold: "Basic exemption limit",
    notes: "Deducted by employer on estimated annual salary",
  },
  {
    section: "194A",
    description: "Interest other than on securities",
    rate_individual: 10,
    rate_company: 10,
    threshold: "₹40,000 (banks) / ₹5,000 (others)",
    notes: "Senior citizens: ₹50,000 threshold for banks",
  },
  {
    section: "194C",
    description: "Payments to contractors",
    rate_individual: 1,
    rate_company: 2,
    threshold: "₹30,000 per contract / ₹1,00,000 aggregate",
    notes: "Individual/HUF 1%, Company/others 2%",
  },
  {
    section: "194D",
    description: "Insurance commission",
    rate_individual: 5,
    rate_company: 5,
    threshold: "₹15,000 aggregate",
    notes: "—",
  },
  {
    section: "194H",
    description: "Commission or brokerage",
    rate_individual: 5,
    rate_company: 5,
    threshold: "₹15,000 aggregate",
    notes: "Excludes securities brokerage (covered by 194I)",
  },
  {
    section: "194I",
    description: "Rent",
    rate_individual: "10 / 2",
    rate_company: "10 / 2",
    threshold: "₹2,40,000 aggregate per year",
    notes: "Land/building/furniture 10%, Plant & machinery 2%",
  },
  {
    section: "194J",
    description: "Professional / technical services",
    rate_individual: 10,
    rate_company: 10,
    threshold: "₹30,000 per year",
    notes: "Technical services reduced to 2% w.e.f. 01-Apr-2020; professional fee remains 10%",
  },
  {
    section: "194LA",
    description: "Compensation on compulsory acquisition",
    rate_individual: 10,
    rate_company: 10,
    threshold: "₹2,50,000",
    notes: "Agricultural land exempt",
  },
  {
    section: "194O",
    description: "E-commerce operator payments",
    rate_individual: 1,
    rate_company: 1,
    threshold: "₹5,00,000 aggregate",
    notes: "1% on gross sale via e-commerce platform (Amazon, Flipkart, etc.)",
  },
  {
    section: "194Q",
    description: "Purchase of goods",
    rate_individual: 0.1,
    rate_company: 0.1,
    threshold: "₹50,00,000 aggregate annual purchase from single seller",
    notes: "Applicable only if buyer's turnover > ₹10 crore in preceding FY",
  },
  {
    section: "194R",
    description: "Benefit or perquisite from business/profession",
    rate_individual: 10,
    rate_company: 10,
    threshold: "₹20,000 aggregate",
    notes: "Gifts, hospitality, incentives given to dealers/agents; w.e.f. 01-Jul-2022",
  },
  {
    section: "194S",
    description: "Payment for virtual digital assets (crypto)",
    rate_individual: 1,
    rate_company: 1,
    threshold: "₹50,000 (specified person) / ₹10,000 (others)",
    notes: "w.e.f. 01-Jul-2022",
  },
  {
    section: "206C",
    description: "TCS — Tax Collected at Source",
    rate_individual: "0.1–5",
    rate_company: "0.1–5",
    threshold: "Varies by category",
    notes: "Collected by seller on scrap, minerals, foreign remittance, luxury goods, etc.",
  },
];

// ─── HSN / GST Rates ─────────────────────────────────────────────────────────

export const HSN_ROWS: HsnRow[] = [
  // Nil / Exempt
  { hsn_prefix: "0101–0106", description: "Live animals", cgst_rate: 0, sgst_rate: 0, igst_rate: 0, exempt: true },
  { hsn_prefix: "0701–0714", description: "Vegetables (fresh/dried/frozen)", cgst_rate: 0, sgst_rate: 0, igst_rate: 0, exempt: true },
  { hsn_prefix: "1001–1008", description: "Cereals (wheat, rice, maize, etc.) — unpackaged", cgst_rate: 0, sgst_rate: 0, igst_rate: 0, exempt: true },
  { hsn_prefix: "0401–0406", description: "Milk, curd, lassi, buttermilk (unpackaged)", cgst_rate: 0, sgst_rate: 0, igst_rate: 0, exempt: true },
  { hsn_prefix: "0402–0406", description: "Milk powder, cheese, butter (packaged branded)", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5, exempt: false },
  // 5%
  { hsn_prefix: "0901", description: "Coffee (not roasted/instant)", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5, exempt: false },
  { hsn_prefix: "0902", description: "Tea (unprocessed green leaf/black)", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5, exempt: false },
  { hsn_prefix: "1501–1517", description: "Edible oils (groundnut, sunflower, mustard, coconut)", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5, exempt: false },
  { hsn_prefix: "2106", description: "Sugar, jaggery (packaged)", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5, exempt: false },
  { hsn_prefix: "3004", description: "Medicines and pharmaceutical products", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5, exempt: false },
  { hsn_prefix: "6101–6117", description: "Apparel / clothing under ₹1,000 MRP", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5, exempt: false },
  { hsn_prefix: "6401–6405", description: "Footwear under ₹1,000 MRP", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5, exempt: false },
  { hsn_prefix: "4901", description: "Printed books, newspapers, journals", cgst_rate: 0, sgst_rate: 0, igst_rate: 0, exempt: true },
  // 12%
  { hsn_prefix: "1904–1905", description: "Processed food — biscuits, breakfast cereals, pastry", cgst_rate: 6, sgst_rate: 6, igst_rate: 12, exempt: false },
  { hsn_prefix: "3301–3307", description: "Personal care — toothpaste, soap, shampoo, deodorant", cgst_rate: 6, sgst_rate: 6, igst_rate: 12, exempt: false },
  { hsn_prefix: "8443", description: "Printers (desktop/commercial)", cgst_rate: 6, sgst_rate: 6, igst_rate: 12, exempt: false },
  { hsn_prefix: "9401–9403", description: "Furniture — chairs, tables, office furniture", cgst_rate: 6, sgst_rate: 6, igst_rate: 12, exempt: false },
  { hsn_prefix: "6101–6117", description: "Apparel / clothing above ₹1,000 MRP", cgst_rate: 6, sgst_rate: 6, igst_rate: 12, exempt: false },
  // 18%
  { hsn_prefix: "8471", description: "Computers, laptops, tablets", cgst_rate: 9, sgst_rate: 9, igst_rate: 18, exempt: false },
  { hsn_prefix: "8517", description: "Mobile phones, telephones, networking equipment", cgst_rate: 9, sgst_rate: 9, igst_rate: 18, exempt: false },
  { hsn_prefix: "8508–8509", description: "Electrical appliances (washing machine, AC, refrigerator)", cgst_rate: 9, sgst_rate: 9, igst_rate: 18, exempt: false },
  { hsn_prefix: "8525–8528", description: "Cameras, TVs, monitors", cgst_rate: 9, sgst_rate: 9, igst_rate: 18, exempt: false },
  { hsn_prefix: "2710", description: "Petroleum products (petrol, diesel, ATF) — GST not applicable (subsumed)", cgst_rate: 0, sgst_rate: 0, igst_rate: 0, exempt: true },
  { hsn_prefix: "3923–3926", description: "Plastic goods, packaging material", cgst_rate: 9, sgst_rate: 9, igst_rate: 18, exempt: false },
  { hsn_prefix: "4820–4823", description: "Paper, stationery, printed material", cgst_rate: 9, sgst_rate: 9, igst_rate: 18, exempt: false },
  { hsn_prefix: "7323–7326", description: "Iron & steel goods, hardware", cgst_rate: 9, sgst_rate: 9, igst_rate: 18, exempt: false },
  { hsn_prefix: "9503–9508", description: "Sports goods, toys, games", cgst_rate: 9, sgst_rate: 9, igst_rate: 18, exempt: false },
  { hsn_prefix: "2201–2202", description: "Water (packaged/mineral water)", cgst_rate: 9, sgst_rate: 9, igst_rate: 18, exempt: false },
  // 28%
  { hsn_prefix: "8703", description: "Motor cars, SUVs (>1200cc / >1500cc diesel)", cgst_rate: 14, sgst_rate: 14, igst_rate: 28, exempt: false },
  { hsn_prefix: "2402", description: "Cigarettes, bidis, tobacco products", cgst_rate: 14, sgst_rate: 14, igst_rate: 28, exempt: false },
  { hsn_prefix: "2208", description: "Liquor for human consumption (alcoholic beverages)", cgst_rate: 0, sgst_rate: 0, igst_rate: 0, exempt: true },
  { hsn_prefix: "8802–8803", description: "Aircraft, aircraft parts", cgst_rate: 14, sgst_rate: 14, igst_rate: 28, exempt: false },
  { hsn_prefix: "9506", description: "Aerated drinks / carbonated beverages", cgst_rate: 14, sgst_rate: 14, igst_rate: 28, exempt: false },
];

// ─── SAC / Service GST Rates ──────────────────────────────────────────────────

export const SAC_ROWS: SacRow[] = [
  // Exempt / Nil
  { sac: "9954", description: "Healthcare services by clinical establishments / doctors", cgst_rate: 0, sgst_rate: 0, igst_rate: 0 },
  { sac: "9991", description: "Educational services by schools, colleges, universities", cgst_rate: 0, sgst_rate: 0, igst_rate: 0 },
  { sac: "9971", description: "Financial services — banking deposits, loans (interest)", cgst_rate: 0, sgst_rate: 0, igst_rate: 0 },
  { sac: "9993", description: "Social welfare services — NGOs, charitable organisations", cgst_rate: 0, sgst_rate: 0, igst_rate: 0 },
  // 5%
  { sac: "9964", description: "Transport of passengers — metered taxi, auto, Ola/Uber non-AC", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5 },
  { sac: "9965", description: "Goods transport by road (GTA) — recipient liable under RCM", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5 },
  { sac: "9966", description: "Transport by rail (economy/non-AC)", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5 },
  { sac: "9963", description: "Restaurant / food supply services at non-AC restaurants", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5 },
  { sac: "9967", description: "Supply of tour operator services", cgst_rate: 2.5, sgst_rate: 2.5, igst_rate: 5 },
  // 12%
  { sac: "9963", description: "Restaurant services at AC restaurants", cgst_rate: 6, sgst_rate: 6, igst_rate: 12 },
  { sac: "9972", description: "Real estate services — renting of residential premises", cgst_rate: 0, sgst_rate: 0, igst_rate: 0 },
  { sac: "9972", description: "Real estate services — renting of commercial premises", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9983", description: "Research and development services", cgst_rate: 6, sgst_rate: 6, igst_rate: 12 },
  // 18%
  { sac: "9961–9962", description: "Professional / consulting services (CA, legal, medical advisory, IT consulting)", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9984", description: "Telecommunications — voice, data, broadband (Airtel, Jio, Vi)", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9985", description: "Support services — security, housekeeping, manpower supply", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9986", description: "Agriculture / farm support services", cgst_rate: 0, sgst_rate: 0, igst_rate: 0 },
  { sac: "9973", description: "Leasing / rental of equipment or vehicles", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9981", description: "Legal services (advocate to business)", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9988", description: "Manufacturing services on goods owned by others (job work)", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9987", description: "Maintenance & repair services (equipment, software, vehicles)", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9968", description: "Postal and courier services (commercial couriers)", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9997", description: "Subscription / membership services, online content platforms", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  { sac: "9983", description: "Software development, IT / ITES services", cgst_rate: 9, sgst_rate: 9, igst_rate: 18 },
  // 28%
  { sac: "9995", description: "Entertainment / amusement services — cinemas, theme parks (over ₹100 ticket)", cgst_rate: 14, sgst_rate: 14, igst_rate: 28 },
  { sac: "9996", description: "Gambling / betting / lottery services", cgst_rate: 14, sgst_rate: 14, igst_rate: 28 },
];

// ─── Reverse Charge Mechanism (Section 9(3) CGST Act) ─────────────────────────

export const RCM_ROWS: RcmRow[] = [
  {
    service: "Goods Transport Agency (GTA) — road freight",
    sac: "9965",
    rate: 5,
    notes: "Recipient (registered business) must pay 5% GST directly; no ITC for GTA on their outward supply",
    notification: "Notif. 13/2017-CT(R)",
  },
  {
    service: "Legal services by an advocate to a business entity",
    sac: "9982",
    rate: 18,
    notes: "If advocate provides services to any registered business, recipient pays GST under RCM",
    notification: "Notif. 13/2017-CT(R)",
  },
  {
    service: "Services by an arbitral tribunal",
    sac: "9982",
    rate: 18,
    notes: "Business entity receiving arbitration services pays GST under RCM",
    notification: "Notif. 13/2017-CT(R)",
  },
  {
    service: "Sponsorship services",
    sac: "9983",
    rate: 18,
    notes: "Body corporate / partnership paying for sponsorship pays GST under RCM",
    notification: "Notif. 13/2017-CT(R)",
  },
  {
    service: "Director remuneration (non-employee director)",
    sac: "9985",
    rate: 18,
    notes: "Company pays GST on remuneration to directors who are not employees",
    notification: "Notif. 13/2017-CT(R)",
  },
  {
    service: "Insurance agent services to insurance company",
    sac: "9971",
    rate: 18,
    notes: "Insurance company (not the agent) pays GST under RCM",
    notification: "Notif. 13/2017-CT(R)",
  },
  {
    service: "Import of services (OIDAR and other services from abroad)",
    sac: "Any",
    rate: 18,
    notes: "Indian company importing any service from abroad pays IGST under RCM (e.g. Google Ads, LinkedIn, AWS, Zoom)",
    notification: "Section 5(3) IGST Act",
  },
  {
    service: "Security services from unregistered person",
    sac: "9985",
    rate: 18,
    notes: "If security guard supplier is unregistered, registered business pays GST under RCM",
    notification: "Notif. 29/2018-CT(R)",
  },
  {
    service: "Renting of land / residential premises by unregistered landowner to registered business",
    sac: "9972",
    rate: 18,
    notes: "w.e.f. 18-Jul-2022: registered businesses renting residential property for commercial use must pay GST under RCM",
    notification: "Notif. 05/2022-CT(R)",
  },
];

// ─── ITC Eligibility (CGST Act Section 17(5)) ────────────────────────────────

export const ITC_ROWS: ItcRow[] = [
  // Blocked
  {
    category: "Motor vehicles for personal use (cars ≤13 seats / motorcycles)",
    itc_allowed: false,
    reason: "S.17(5)(a) — ITC blocked on motor vehicles used for transportation of persons with ≤13 seating capacity, unless used for further supply, transportation of passengers, or driving school",
  },
  {
    category: "Food, beverages, outdoor catering, beauty treatment",
    itc_allowed: false,
    reason: "S.17(5)(b)(i) — ITC on food/drinks/outdoor catering blocked unless same category of supply is made outwardly (e.g., restaurant business)",
  },
  {
    category: "Club memberships, health & fitness centres",
    itc_allowed: false,
    reason: "S.17(5)(b)(ii) — ITC blocked on membership fees for clubs, gyms, sports facilities",
  },
  {
    category: "Travel benefits to employees — LTA, vacation packages",
    itc_allowed: false,
    reason: "S.17(5)(b)(iii) — ITC blocked on travel benefits extended to employees/their families",
  },
  {
    category: "Works contract for immovable property (civil construction)",
    itc_allowed: false,
    reason: "S.17(5)(c) — ITC blocked on works contract for construction of immovable property, except plant & machinery",
  },
  {
    category: "Construction of immovable property on own account",
    itc_allowed: false,
    reason: "S.17(5)(d) — GST paid on goods/services used for own construction capitalized into building — ITC blocked",
  },
  {
    category: "Personal purchases, gifts to employees / non-business use",
    itc_allowed: false,
    reason: "S.17(1) — ITC is available only to the extent used for business. Personal or non-business use is fully blocked",
  },
  {
    category: "Composition scheme taxpayers",
    itc_allowed: false,
    reason: "S.10 — Composition dealers cannot claim ITC on any inward supply",
  },
  // Allowed
  {
    category: "Purchase of goods / raw material for manufacturing",
    itc_allowed: true,
    reason: "S.16 — ITC on goods used in the course or furtherance of business is fully claimable",
  },
  {
    category: "Expenses for business operations — stationery, office supplies",
    itc_allowed: true,
    reason: "S.16 — Used in course of business; full ITC available",
  },
  {
    category: "IT services, software subscriptions, cloud hosting",
    itc_allowed: true,
    reason: "S.16 — Business purpose; full ITC available (AWS, Azure, Google Workspace, etc.)",
  },
  {
    category: "Mobile phones and laptops used for business",
    itc_allowed: true,
    reason: "S.16 — Used in course of business; ITC available (ensure documentation that it is for business use)",
  },
  {
    category: "Professional services — CA, legal, consulting",
    itc_allowed: true,
    reason: "S.16 — Business purpose; full ITC available",
  },
  {
    category: "Advertising and marketing expenses",
    itc_allowed: true,
    reason: "S.16 — Business purpose; full ITC available",
  },
  {
    category: "Courier and freight charges (domestic)",
    itc_allowed: true,
    reason: "S.16 — Business input; full ITC available",
  },
  {
    category: "Motor vehicles used for goods transport / commercial vehicles",
    itc_allowed: true,
    reason: "S.17(5)(a) exception — ITC allowed on vehicles designed primarily for goods transportation (trucks, vans, tempos)",
  },
  {
    category: "Capital goods (plant & machinery, equipment)",
    itc_allowed: true,
    reason: "S.16 — ITC on capital goods used in business is allowed, subject to ITC reversal on exempt supply proportion",
  },
];
