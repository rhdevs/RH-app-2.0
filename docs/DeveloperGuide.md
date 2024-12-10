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

## User Stories

| Priority | As a …        | I want to …                                            | So that I can …                                       | Remarks/Notes                                        |
| -------- | ------------- | ------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------- |
| `* * *`  | Hall Resident | Book available facilities such as gyms and study rooms | Plan my activities and reserve resources conveniently | Include real-time availability checking for accuracy |
| `* * *`  | Hall Resident | View my bookings on a calendar                         | See all my reservations at a glance                   | Weekly and monthly views for better usability        |
| `* * *`  | Admin         | Block facilities for events                            | Prevent users from booking unavailable facilities     | Add error messages for conflicts                     |
| `* * *`  | CCA Leader    | Track attendance for CCA members                       | Allocate points for participation fairly              | Include options for adding/removing members          |
| `* * *`  | Hall Resident | Join a CCA                                             | Participate in extracurricular activities             | Make CCAs more accessible for residents              |
| `* *`    | CCA Leader    | Generate reports of CCA attendance and points          | Share records with hall management or stakeholders    | Include export options for CSV or PDF formats        |
| `* *`    | Hall Resident | Receive reminders for upcoming bookings                | Stay updated about my reservations                    | Notifications via email or app push notifications    |
| `* *`    | Admin         | View analytics for facility usage                      | Monitor trends and optimize facility management       | Include charts and graphs for data visualization     |
| `*`      | Hall Resident | Cancel a facility booking                              | Free up slots if my plans change                      | Provide easy cancellation options                    |
| `*`      | Admin         | Assign roles to users                                  | Limit access to certain administrative features       | Role-based access control for security               |
| `*`      | Hall Resident | Search for specific CCAs based on interests            | Quickly find activities I’m passionate about          | Add a filter or search bar                           |

---

## Use Cases

### **UC01 - Book a Facility**

**System**: RHApp  
**Actor**: Hall Resident

**Description**: This use case allows a hall resident to book a facility such as a gym or study room.

**Preconditions**:

1. The resident must have an active account.
2. The facility must be available for booking during the selected time slot.

**Main Success Scenario (MSS)**:

1. Resident selects the desired facility from the facilities list.
2. Resident chooses a date and time slot.
3. System checks for availability and conflicts.
4. System confirms the booking and displays the reservation details.

**Extensions**:

- **2a. Facility is unavailable for the selected time slot**:
  - 2a1. System displays an error message with alternative available time slots.
  - 2a2. Resident selects a different time slot.

---

### **UC02 - Block Facility for Events**

**System**: RHApp  
**Actor**: Admin

**Description**: This use case allows admins to block facilities for events or other purposes.

**Preconditions**:

1. The admin must be logged in with the appropriate permissions.

**Main Success Scenario (MSS)**:

1. Admin selects the facility to block from the facilities list.
2. Admin specifies the time period for blocking.
3. System marks the facility as unavailable for the selected time period.
4. System prevents new bookings during the blocked period.

**Extensions**:

- **2a. Admin forgets to specify the end time**:
  - 2a1. System prompts the admin to enter an end time.

---

### **UC03 - Join a CCA**

**System**: RHApp  
**Actor**: Hall Resident

**Description**: This use case allows a hall resident to join a CCA.

**Preconditions**:

1. The resident must have an active account.

**Main Success Scenario (MSS)**:

1. Resident browses the list of available CCAs.
2. Resident selects a CCA to join.
3. System registers the resident for the selected CCA.
4. System updates the CCA’s member list and displays a success message.

---

### **UC04 - Generate Attendance Reports**

**System**: RHApp  
**Actor**: CCA Leader

**Description**: This use case allows a CCA leader to generate attendance and point allocation reports.

**Preconditions**:

1. The CCA leader must have admin privileges for the selected CCA.
2. Attendance data must be recorded in the system.

**Main Success Scenario (MSS)**:

1. CCA leader selects the CCA for which to generate a report.
2. CCA leader specifies the reporting period.
3. System compiles the attendance and points data into a report.
4. System displays the report and provides export options (CSV or PDF).

---

### **UC05 - View Calendar**

**System**: RHApp  
**Actor**: Hall Resident

**Description**: This use case allows a hall resident to view their personal bookings and hall events on a unified calendar.

**Preconditions**:

1. The resident must have an active account.
2. The calendar must be populated with relevant data.

**Main Success Scenario (MSS)**:

1. Resident opens the calendar view.
2. System displays personal bookings, hall events, and CCA activities.
3. Resident toggles between weekly and monthly views.
4. Resident clicks on an event to see its details.

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
