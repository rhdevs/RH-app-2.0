/*
  Warnings:

  - A unique constraint covering the columns `[description]` on the table `Facility` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Facility_description_key" ON "Facility"("description");
