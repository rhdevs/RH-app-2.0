import { useState } from 'react';

export default function FacilitySelector({ facilities }) {
    const [selectedId, setSelectedId] = useState('');

    const handleChange = (e) => {
        const id = e.target.value;
        //console.log('Selected facility ID:', id);
        setSelectedId(id);
    };

    return (
        <div className="my-6">
        <label htmlFor="facility-select" className="block font-medium mb-2">
            Choose a facility:
        </label>
        <select
            id="facility-select"
            value={selectedId}
            onChange={handleChange}
            className="w-full max-w-sm rounded-xl border-gray-300 p-2"
        >
            <option value="">— Select one —</option>
            {facilities.map((f) => (
            <option key={f._id} value={f._id}>
                {f.name}
            </option>
            ))}
        </select>
        </div>
    );

}
