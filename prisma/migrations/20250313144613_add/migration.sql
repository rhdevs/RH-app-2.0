/*
  Warnings:

  - Added the required column `slot` to the `Event` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "slot" TIMESTAMP(3) NOT NULL;
