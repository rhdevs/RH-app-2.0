"use client";

import { useState } from 'react';
import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import Image from 'next/image';

// Hardcoded Facilities Data (REMOVE THIS)
interface Facility {
  _id: string;
  name: string;
  directions: string;
  operatingHours: string;
  description?: string;
  images?: string[];
}
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

// Facilities Page
const FacilitiesPage: React.FC = () => {
  const [selectedId, setSelectedId] = useState('');

  return (
    <div className='flex flex-col items-center md:flex-row h-svh w-svh md:p-8'>
      
      {/* Content Box */}
      <div className="flex flex-col justify-center overflow-visible w-5/6 md:w-2/5 h-fit md:h-2/5 border-2 rounded-xl border-gray-300 p-8 m-4">

          {/* Select component and Book Button */}
          <div className='flex flex-row justify-between items-center pb-8'>  
              <Select value={selectedId} onValueChange={setSelectedId}>
                <SelectTrigger className="text-base h-12 w-1/2 max-w-sm rounded-xl border-2 border-gray-300 p-2 hover:border-gray-700">
                  <SelectValue placeholder="Select a Facility" />
                </SelectTrigger>
                <SelectContent className="text-base">
                  {facilities.map((f) => (
                    <SelectItem key={f._id} value={f._id}>
                        {f.name}
                    </SelectItem>
                    ))}
                </SelectContent>
              </Select> 

            {/* Replace with actual BOOK button later */}
            <button className="focus:outline-none text-white bg-purple-700 hover:bg-purple-800 focus:ring-4 focus:ring-purple-300 font-medium rounded-lg text-sm px-5 mb-2 h-10">
              Book
            </button>
          </div>

          {/* Display Text */}
          {/* If none selected then, */}
          {!(selectedId && (selectedId != "-1")) && (
            <h1 className='text-3xl font-bold'>Welcome to Raffles Hall!</h1>
          )}

          {/* If facility selected then, */}
          {selectedId && (selectedId != "-1") && (
            <div>
              <h1 className="text-5xl font-bold mt-2 text-green-600">{facilities[selectedId].name}</h1>
              <p  className="text-lg">{`📍 ${facilities[selectedId].directions}`}</p>
              <p  className="text-lg">
                <span className="font-semibold">🕒 Operating Hours: </span>
                {facilities[selectedId].operatingHours}
                </p>
            </div>
          )}
      </div>
      
      {/* Display Image */}
      <div className="h-full w-full relative">
          <Image
            src={`/facilities-images/${(selectedId)? selectedId : "-1"}.jpg`}           // changes based on selection
            alt={facilities[(selectedId)? selectedId : "-1"]}
            layout="fill"
            objectFit="cover"
          />
      </div>
    </div>
  );
};

export default FacilitiesPage;
