<!--
layout: default.md
title: "Developer Guide"
pageNav: 3
---
-->

# RHApp Developer Guide

<!-- * Table of Contents -->
<page-nav-print />

---

## **Acknowledgements**

Libraries used: [Next.js](https://nextjs.org/), [Tailwind CSS](https://tailwindcss.com/), [tRPC](https://trpc.io/), [Prisma](https://www.prisma.io/).  
This project is built using the T3 stack and leverages tools for modern web development, such as Vercel for hosting.

---

## **Setting up, getting started**

Refer to the guide [_Setting up and getting started_](SettingUp.md).

---

## **Design**

### Architecture

The **_Architecture Diagram_** explains the high-level design of the application. (Insert diagram here)

The RHApp architecture consists of the following main components:

1. **Frontend**:

   - Built with Next.js and styled using Tailwind CSS.
   - Handles user interactions and API communication via tRPC.

2. **Backend**:

   - Built using tRPC with Next.js API routes.
   - Manages the business logic and interactions with the database through Prisma.

3. **Database**:

   - Currently using PostgreSQL, managed through Prisma ORM for schema definitions and migrations.
   - **Note:** MongoDB is being evaluated as an alternative as there is pre-existing data that may need to be migrated over from the old application.

4. **Authentication**:

   - Implements NextAuth.js for secure user login and session handling.

5. **Hosting**:

   - Deployed on Vercel, allowing for easy continuous integration and deployment.

---

## **Key Features**

### **1. Facilities Booking**

Users can view and book available facilities such as gyms, study rooms, and recreational areas.

- Conflict prevention through real-time availability checking.

### **2. Calendar View**

A unified calendar displays:

- Personal bookings.
- Hall events and announcements.

**Key Details**:

- Supports weekly and monthly views.
- Color-coded events for better visualization.

### **3. CCA Attendance & Sign-Up**

Users can browse, join, and track participation in hall CCAs.

**Extensions**:

- **Admin Reports**:
  - Admins can generate detailed reports for participation and point allocation.
  - Reports include attendance summaries, individual member contributions, and total points for events.
  - Export options for CSV or PDF formats are planned for easier sharing.

---

## **Development Workflow**

1. **Repository Setup**:

   - Clone the repository:
     ```bash
     git clone [https://github.com/username/RHApp.git](https://github.com/rhdevs/RH-app-2.0.git)
     ```
   - Install dependencies:
     ```bash
     npm install
     ```
   - Start the development server:
     ```bash
     npm run dev
     ```
   - Set up environment variables using .env

2. **Branching Strategy**:

   - Use the `main` branch for production-ready code.
   - Use feature branches (`[username]/[feature]`) for new features or updates.

3. **Testing**:
   To be decided

---

## **API Design**

To be decided
