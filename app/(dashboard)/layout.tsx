import { Sidebar } from "@/components/layout/sidebar";
import { DemoBar } from "@/components/demo/DemoBar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 ml-60 p-8 pb-24">
        {children}
      </main>
      <DemoBar />
    </div>
  );
}
