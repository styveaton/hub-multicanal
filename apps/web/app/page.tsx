import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Hub Multi-canal</h1>
      <p className="muted">Une fiche produit, tous vos canaux de vente : eBay, Amazon, TikTok Shop.</p>
      <p>
        <Link href="/signup">Créer un compte</Link> · <Link href="/login">Se connecter</Link>
      </p>
    </main>
  );
}
