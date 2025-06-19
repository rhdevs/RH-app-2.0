"use client";

import { useState } from 'react';
import React from "react";
import {Facility, FacilitySelector} from '@/components/ui/facilities/FacilitySelector';

const facilities: Facility[] = [
  {
    _id: '1',
    name: 'Alumni Room',
    directions: 'Upper Lounge Room 1',
    operatingHours: '09:00 – 21:00',
  },
  {
    _id: '2',
    name: 'Gym',
    directions: 'Below the Community Hall',
    operatingHours: '07:30 – 20:30',
  },
  {
    _id: '3',
    name: 'Basketball Court',
    directions: 'Next to the Outdoor Pool, East Wing',
    operatingHours: '06:00 – 22:00',
  },
  {
    _id: '4',
    name: 'Dance Studio',
    directions: '2nd Floor, Arts & Rec Building',
    operatingHours: '08:00 – 18:00',
  },
];

const FacilitiesPage: React.FC = () => {
  const [selectedId, setSelectedId] = useState('');

  return (
    <div>
      <h1>Facilities Page</h1>
      {/* Add your facilities content here */}
      <FacilitySelector 
        facilities={facilities} 
        selectedId={selectedId} 
        onChange={setSelectedId} 
      />

      {selectedId && (
      <p className="mt-2 text-green-600">You picked: {facilities[selectedId-1].name}</p>
      )}

    </div>
  );
};

export default FacilitiesPage;
