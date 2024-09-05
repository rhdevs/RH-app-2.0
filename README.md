Steps to run the repo locally

- Git Clone the repo to your machine
- Download Node(18.20.4) and npm/bun
  - Recommend Using nvm https://github.com/nvm-sh/nvm but not neccessary
- Copy .env.example and name it .env
- Download Postgresql and start a server on your machine
  - https://www.postgresqltutorial.com/postgresql-getting-started/install-postgresql
  - https://www.postgresqltutorial.com/postgresql-getting-started/connect-to-postgresql-database/
- Add posgresql connection string from the server you just created to .env and replace the DATABASE_URL
- run bunx/npx prisma db push
- run npm install/bun install
- run npm run dev/bun run dev
  - Should see the purple create t3 App screen
- run bunx/npx prisma studio
  - Should see the Prisma studio screen

Other stuff to set up if you have time can look for guides online or ask in the chat.

- Eslint
- Prettier

Once done, Add your name below and refer to the contribution guide below to push it(this will be the rough workflow we will go through for all our work).

Done:
Zi Yang
Ernest

Contribution Guide: refer to https://rogerdudler.github.io/git-guide/ for basic git usage
Create a branch and name it yourname/branchname.
Push changes to your to your new branch (make sure your on your new branch)
Once done, create a merge request to main.

# Create T3 App

This is a [T3 Stack](https://create.t3.gg/) project bootstrapped with `create-t3-app`.

## What's next? How do I make an app with this?

We try to keep this project as simple as possible, so you can start with just the scaffolding we set up for you, and add additional things later when they become necessary.

If you are not familiar with the different technologies used in this project, please refer to the respective docs. If you still are in the wind, please join our [Discord](https://t3.gg/discord) and ask for help.

- [Next.js](https://nextjs.org)
- [NextAuth.js](https://next-auth.js.org)
- [Prisma](https://prisma.io)
- [Drizzle](https://orm.drizzle.team)
- [Tailwind CSS](https://tailwindcss.com)
- [tRPC](https://trpc.io)

## Learn More

To learn more about the [T3 Stack](https://create.t3.gg/), take a look at the following resources:

- [Documentation](https://create.t3.gg/)
- [Learn the T3 Stack](https://create.t3.gg/en/faq#what-learning-resources-are-currently-available) — Check out these awesome tutorials

You can check out the [create-t3-app GitHub repository](https://github.com/t3-oss/create-t3-app) — your feedback and contributions are welcome!

## How do I deploy this?

Follow our deployment guides for [Vercel](https://create.t3.gg/en/deployment/vercel), [Netlify](https://create.t3.gg/en/deployment/netlify) and [Docker](https://create.t3.gg/en/deployment/docker) for more information.
