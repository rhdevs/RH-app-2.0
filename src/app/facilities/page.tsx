"use client";

import { useState } from 'react';
import React from "react";
import {Facility, FacilitySelector} from '@/components/ui/facilities/FacilitySelector';

const facilities: Facility[] = [
  {
    _id: '0',
    name: 'Alumni Room',
    directions: 'Upper Lounge Room 1',
    operatingHours: '09:00 – 21:00',
  },
  {
    _id: '1',
    name: 'Gym',
    directions: 'Below the Community Hall',
    operatingHours: '07:30 – 20:30',
  },
  {
    _id: '2',
    name: 'Basketball Court',
    directions: 'Next to the Outdoor Pool, East Wing',
    operatingHours: '06:00 – 22:00',
  },
  {
    _id: '3',
    name: 'Dance Studio',
    directions: '2nd Floor, Arts & Rec Building',
    operatingHours: '08:00 – 18:00',
  },
];

const FacilitiesPage: React.FC = () => {
  const [selectedId, setSelectedId] = useState('');

  return (
    <div 
      className="w-full h-svh bg-cover bg-center p-8"
      style={{ backgroundImage: `url('/facilities-images/${(selectedId)? selectedId : "-1"}.jpg')` }}
      >
      <div className="w-fit bg-white p-8">
        {/* Add your facilities content here */}
        <FacilitySelector 
          facilities={facilities} 
          selectedId={selectedId} 
          onChange={setSelectedId} 
        />

        {!(selectedId && (selectedId != "-1")) && (
          <p>Welcome to Raffles Hall!</p>
        )}

        {selectedId && (selectedId != "-1") && (
        <p className="mt-2 text-green-600">You picked: {facilities[selectedId].name}</p>
        )}
      </div>

    </div>
  );
};

export default FacilitiesPage;
