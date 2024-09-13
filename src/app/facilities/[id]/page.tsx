import React from "react";

interface FacilitiesPageProps {
  id: React.ReactNode;
}

const FacilitiesPage: React.FC<FacilitiesPageProps> = ({ id }) => {
  return (
    <div>
      <h1>Facilities Page</h1>
      <h1>{id}</h1>
      {/* Add your facilities content here */}
    </div>
  );
};

export default FacilitiesPage;
