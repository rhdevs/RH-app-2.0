"use client";
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
  const onSubmit: SubmitHandler<LoginInput> = (data) => signIn("credentials", { ...data });

  return (
    <div className="flex flex-col items-center justify-center gap-8 p-12">
      <h2 className="font-bold">Welcome to Raffles Hall! Please sign in to continue</h2>

      <form className="flex flex-col items-center gap-6">
        <input
          type="text"
          placeholder="Email"
          className="rounded-md border border-zinc-300 px-6 py-2"
          {...register("email")}
        />
        <input
          type="password"
          placeholder="Password"
          className="rounded-md border border-zinc-300 px-6 py-2"
          {...register("password")}
        />
        <button
          type="submit"
          className="rounded-md border border-zinc-300 bg-white px-6 py-2 text-zinc-700"
          onClick={handleSubmit(onSubmit)}
        >
          Login
        </button>
      </form>

      <button
        className="rounded-md border border-zinc-300 bg-white px-6 py-2 text-zinc-700"
        disabled={true}
        onClick={() => signIn("google")}
      >
        <span className="mr-2 font-bold text-red-700">G</span> Sign in with
        Google
      </button>
      {/* <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="username">Username:</label>
          <input
            type="text"
            id="username"
            value={username}
            onChange={handleUsernameChange}
          />
        </div>
        <div>
          <label htmlFor="password">Password:</label>
          <input
            type="password"
            id="password"
            value={password}
            onChange={handlePasswordChange}
          />
        </div>
        <button type="submit">Login</button>
      </form> */}
    </div>
  );
};

export default LoginPage;
