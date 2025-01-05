"use client";
import React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@radix-ui/react-avatar";
import { useSession, signOut } from "next-auth/react";
import { Button } from "~/components/ui/button";

const ProfilePage: React.FC = () => {
  const { data: session } = useSession() as {
    data: { user: { name: string; email: string; image: "string" } };
  };

  return (
    <div className="flex flex-col items-center justify-center p-6">
      <Avatar className="flex h-[100px] w-[100px] items-center justify-center overflow-auto rounded-full bg-gray-500">
        <AvatarImage
          src={session?.user.image}
          alt={session?.user.name}
        ></AvatarImage>
        <AvatarFallback className="text-xl font-bold text-white">
          {session?.user.name[0]}
        </AvatarFallback>
      </Avatar>
      <h1 className="text-3xl font-bold">{session?.user.name}</h1>
      <p>{session?.user.email}</p>
      <Button onClick={() => signOut()} className="mt-8">
        Log Out
      </Button>
      {/* Add your profile information here */}
    </div>
  );
};

export default ProfilePage;
