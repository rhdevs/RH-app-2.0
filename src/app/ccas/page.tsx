import CcaBrowseGrid from "./_components/CcaBrowseGrid";

export const dynamic = "force-dynamic";

/** Browse every CCA and apply to join one. The layout established "signed in";
 *  the grid's data comes from a procedure that enforces the kill switch. */
export default function CcasBrowsePage() {
  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-semibold text-gray-900">Explore CCAs</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Find a co-curricular activity and apply to become a member.
        </p>
      </header>
      <CcaBrowseGrid />
    </div>
  );
}
