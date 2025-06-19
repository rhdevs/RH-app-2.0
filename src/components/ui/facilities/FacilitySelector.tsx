export interface Facility {
  _id: string;
  name: string;
  directions: string;
  operatingHours: string;
  description?: string;
  images?: string[];
}

interface FacilitySelectorProps {
  facilities: Facility[];
  selectedId: string;
  onChange: (id: string) => void;
}

export const FacilitySelector: React.FC<FacilitySelectorProps> = ({
  facilities,
  selectedId,
  onChange,
}) => {

    return (
        <div className="my-6">
        <label htmlFor="facility-select" className="block font-medium mb-2">
            Choose a facility:
        </label>
        <select
            id="facility-select"
            value={selectedId}
            onChange={e => onChange(e.target.value)}
            className="w-full max-w-sm rounded-xl border-2 border-gray-300 p-2 hover:border-gray-700"
        >
            <option key="-1" value="-1">Select a Facility</option>
            {facilities.map((f) => (
            <option key={f._id} value={f._id}>
                {f.name}
            </option>
            ))}
        </select>
        </div>
    );

}
