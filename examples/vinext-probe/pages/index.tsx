import Head from "next/head";
import { Counter } from "../components/counter";

interface HomeProps {
  timestamp: string;
}

export async function getServerSideProps(): Promise<{ props: HomeProps }> {
  return {
    props: {
      timestamp: new Date().toISOString(),
    },
  };
}

export default function Home({ timestamp }: HomeProps) {
  return (
    <>
      <Head>
        <title>vinext QuickJS probe</title>
      </Head>
      <h1>Hello from vinext on QuickJS!</h1>
      <p>Rendered at: {timestamp}</p>
      <Counter />
    </>
  );
}
