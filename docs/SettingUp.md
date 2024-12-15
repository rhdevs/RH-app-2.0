## Prerequisites

- [Git](https://git-scm.com/)
- [Node.js (v18.20.4)](https://nodejs.org/)
- [npm](https://www.npmjs.com/) or [bun](https://bun.sh/)
- [PostgreSQL](https://www.postgresql.org/)

## Setup Instructions

1. **Clone the repository**

   ```sh
   git clone <repository-url>
   cd <repository-directory>
   ```

2. **Install Node.js and npm/bun**

   - It is recommended to use [nvm](https://github.com/nvm-sh/nvm) for managing Node.js versions.

   ```sh
   nvm install 18.20.4
   nvm use 18.20.4
   ```

3. **Set up environment variables**

   ```sh
   cp .env.example .env
   ```

4. **Install MongoDB and start running it**

   - Follow the instructions(MacOS) [here](https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-os-x/)
   - Follow the instructions(Windows) [here](https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-windows/)

5. **Configure the database connection**

   - Add your MongoDB connection string to the `.env` file by replacing the `DATABASE_URL` placeholder.
   - Syntax would be "mongodb://localhost:27017/RHDevs" where 27017 is the default port and RHDevs is the database name that you wish to use

6. **Push the Prisma schema to the database**

   ```sh
   bunx prisma db push
   # or
   npx prisma db push
   ```

7. **Install dependencies**

   ```sh
   bun install
   # or
   npm install
   ```

8. **Run the development server**

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
