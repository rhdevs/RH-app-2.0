## Prerequisites

- [Git](https://git-scm.com/)
- [Node.js (v18.20.4)](https://nodejs.org/)
- [npm](https://www.npmjs.com/) or [bun](https://bun.sh/)
- [PostgreSQL](https://www.postgresql.org/)

## Setup Instructions

1. **Clone the repository**

   ```sh
   git clone https://github.com/rhdevs/RH-app-2.0.git
   cd <repository-directory>
   ```

2. **Install Node.js and npm/bun**

   - It is recommended to use [nvm](https://github.com/nvm-sh/nvm) for managing Node.js versions.

   ```sh
   nvm install 18.20.4
   nvm use 18.20.4
   ```

3. **Create environment variables file**

   ```sh
   cp .env.example .env
   ```

4. **Configure the database connection**

   For simplicity, we will be using RHAppDev database as our development server, so there is no need to setup a database locally.

   - Add your MongoDB connection string (ask from us) to the `.env` file by replacing the `DATABASE_URL` placeholder.


5. **Install dependencies**

   ```sh
   bun install
   # or
   npm install
   ```

6. **Run the development server**

   ```sh
   bun run dev
   # or
   npm run dev
   ```

   - You should see the purple Create T3 App screen.

9. **Open Prisma Studio**
   ```sh
   bunx prisma studio
   # or
   npx prisma studio
   ```
   - You should see the Prisma Studio screen.
