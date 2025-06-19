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
      className="w-full h-svh bg-cover bg-center px-8"
      style={{ backgroundImage: `url('/facilities-images/${(selectedId)? selectedId : "-1"}.jpg')` }}
      >
      <div className="w-fit bg-white p-8">
        {/* Add your facilities content here */}
        <div className='flex flex-row justify-between items-center'>
          <FacilitySelector 
            facilities={facilities} 
            selectedId={selectedId} 
            onChange={setSelectedId} 
          />

          <button className="focus:outline-none text-white bg-purple-700 hover:bg-purple-800 focus:ring-4 focus:ring-purple-300 font-medium rounded-lg text-sm px-5 mb-2 h-10">
            Book
          </button>
        </div>
        

        {!(selectedId && (selectedId != "-1")) && (
          <h1 className='text-5xl font-bold'>Welcome to Raffles Hall!</h1>
        )}

        {selectedId && (selectedId != "-1") && (
          <div>
            <h1 className="text-5xl font-bold mt-2 text-green-600">{facilities[selectedId].name}</h1>
            <p  className="text-lg">{facilities[selectedId].directions}</p>
            <p  className="text-lg">
              <span className="font-semibold">Operating Hours: </span>
              {facilities[selectedId].operatingHours}
              </p>
          </div>
        )}
      </div>

    </div>
  );
};

export default FacilitiesPage;
