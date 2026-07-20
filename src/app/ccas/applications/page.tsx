import MyApplicationsList from "../_components/MyApplicationsList";

export const dynamic = "force-dynamic";

/** The resident's own applications across all CCAs. */
export default function MyApplicationsPage() {
  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-semibold text-gray-900">
          My applications
        </h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Track where each of your CCA applications stands.
        </p>
      </header>
      <MyApplicationsList />
    </div>
  );
}
