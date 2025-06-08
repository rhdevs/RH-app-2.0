"use client";
import { Link } from "react-router-dom";
import { signIn } from "next-auth/react";
import { useForm, type SubmitHandler } from "react-hook-form";

interface LoginInput {
  email: string;
  password: string;
}

const LoginPage = () => {
  // const router = useRouter();
  // useEffect(() => {
  //   if (session) {
  //     router.push("/profile"); // Change to your target route
  //   }
  // }, [router]);
  // const [username, setUsername] = useState("");
  // const [password, setPassword] = useState("");

  // const handleUsernameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  //   setUsername(event.target.value);
  // };

  // const handlePasswordChange = (event: React.ChangeEvent<HTMLInputElement>) => {
  //   setPassword(event.target.value);
  // };

  // const handleSubmit = (event: React.FormEvent) => {
  //   event.preventDefault();
  //   // Add your login logic here
  // };

  const { register, handleSubmit } = useForm<LoginInput>();
  const onSubmit: SubmitHandler<LoginInput> = (data) =>
    signIn("credentials", { ...data });

  return (
    <div className="relative flex min-h-screen items-center justify-center">
      <div
        className="absolute inset-0 z-0 bg-cover"
        style={{
          backgroundImage: 'url("rh-sunset.png")',
          // filter: "blur(4px)",
        }}
      ></div>

      <div className="relaive z-10 w-full max-w-md overflow-hidden rounded-xl bg-white shadow-lg">
        {/* Top Image Section */}
        <div
          className="h-56 w-full bg-cover bg-center"
          style={{
            backgroundImage: 'url("raffles-hall.png")',
          }}
        ></div>

        {/* Form Section */}
        <div className="p-6">
          <h2 className="mb-6 text-3xl font-bold text-gray-800">Login</h2>

          <form className="space-y-4">
            <div>
              <input
                type="text"
                placeholder="Email"
                className="bg-white-200 placeholder-grey-700 w-full rounded-[1vw] border px-4 py-2 text-black focus:outline-none"
                {...register("email")}
              />
            </div>

            <div>
              <input
                type="password"
                placeholder="Password"
                className="bg-white-200 placeholder-grey-700 w-full rounded-[1vw] border px-4 py-2 text-black focus:outline-none"
                {...register("password")}
              />
            </div>

            {/* <div className="flex items-center justify-between text-sm text-gray-600">
              <label className="flex items-center">
                <input type="checkbox" className="mr-2" /> remember me
              </label>
              <a href="#" className="hover:underline">
                forgot password
              </a>
            </div> */}

            <button
              type="submit"
              className="w-full rounded bg-green-700 py-2 text-white hover:bg-green-800"
              onClick={handleSubmit(onSubmit)}
            >
              Login
            </button>
            <button
              className="w-full rounded border bg-white py-2 text-zinc-700 hover:bg-zinc-200"
              disabled={true}
              onClick={() => signIn("google")}
            >
              <span className="mr-2 font-bold text-red-700">G</span> Sign in
              with Google
            </button>
          </form>

          <div className="mt-4 text-center">
            <a href="/signup" className="text-sm text-gray-600 hover:underline">
              Create Account
            </a>
          </div>
        </div>
      </div>
    </div>
    // <div className="flex flex-col items-center justify-center gap-8 p-12">
    //   <h2 className="font-bold">
    //     Welcome to Raffles Hall! Please sign in to continue
    //   </h2>

    //   <form className="flex flex-col items-center gap-6">
    //     <input
    //       type="text"
    //       placeholder="Email"
    //       className="rounded-md border border-zinc-300 px-6 py-2"
    //       {...register("email")}
    //     />
    //     <input
    //       type="password"
    //       placeholder="Password"
    //       className="rounded-md border border-zinc-300 px-6 py-2"
    //       {...register("password")}
    //     />
    //     <button
    //       type="submit"
    //       className="rounded-md border border-zinc-300 bg-white px-6 py-2 text-zinc-700"
    //       onClick={handleSubmit(onSubmit)}
    //     >
    //       Login
    //     </button>
    //   </form>

    //   <button
    //     className="rounded-md border border-zinc-300 bg-white px-6 py-2 text-zinc-700"
    //     disabled={true}
    //     onClick={() => signIn("google")}
    //   >
    //     <span className="mr-2 font-bold text-red-700">G</span> Sign in with
    //     Google
    //   </button>
    //   {/* <form onSubmit={handleSubmit}>
    //     <div>
    //       <label htmlFor="username">Username:</label>
    //       <input
    //         type="text"
    //         id="username"
    //         value={username}
    //         onChange={handleUsernameChange}
    //       />
    //     </div>
    //     <div>
    //       <label htmlFor="password">Password:</label>
    //       <input
    //         type="password"
    //         id="password"
    //         value={password}
    //         onChange={handlePasswordChange}
    //       />
    //     </div>
    //     <button type="submit">Login</button>
    //   </form> */}
    // </div>
  );
};

export default LoginPage;
