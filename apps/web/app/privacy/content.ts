import type { Locale } from "@hub/shared";

/**
 * Politique de confidentialité d'OmniList (demandée par eBay, Etsy, Shopify… pour brancher leurs API).
 * Elle décrit ce que l'application fait réellement : à mettre à jour si l'on stocke de nouvelles données.
 */
export const PRIVACY_CONTACT = "privacy@1handbiz.com";
export const PRIVACY_UPDATED: Record<Locale, string> = { fr: "4 novembre 2026", en: "November 4, 2026" };

export interface PrivacySection {
  title: string;
  paragraphs?: string[];
  items?: string[];
}

export interface PrivacyContent {
  title: string;
  updated: string;
  intro: string;
  sections: PrivacySection[];
}

const fr: PrivacyContent = {
  title: "Politique de confidentialité",
  updated: "Dernière mise à jour :",
  intro:
    "OmniList (omnilist.1handbiz.com), édité par 1HandBiz, aide les vendeurs à publier leurs produits et à synchroniser leur stock et leurs commandes sur plusieurs places de marché. Cette page explique quelles données nous traitons, pourquoi, et quels sont vos droits.",
  sections: [
    {
      title: "1. Données que nous collectons",
      items: [
        "Compte : nom, adresse email, mot de passe (stocké uniquement sous forme hachée avec scrypt) et nom de la boutique.",
        "Équipe : adresses email des membres que vous invitez et leur rôle.",
        "Catalogue : produits, variantes, prix, stock et photos que vous ajoutez.",
        "Connexions aux canaux : jetons d'accès fournis par les places de marché (eBay, Etsy, Depop, Shopify, WooCommerce…) après votre accord, chiffrés en AES-256-GCM, ainsi que l'identifiant de votre boutique ou de votre compte vendeur.",
        "Commandes importées depuis vos canaux : numéro de commande, articles, montants, statut, nom de l'acheteur et son identifiant sur la place de marché. Nous ne stockons ni adresse postale ni moyen de paiement des acheteurs.",
        "Données techniques : journaux du serveur (adresse IP, date, page demandée) conservés pour la sécurité et le diagnostic.",
      ],
    },
    {
      title: "2. Pourquoi nous les utilisons",
      items: [
        "Fournir le service : publier et mettre à jour vos annonces, synchroniser le stock entre vos canaux, éviter la double vente et centraliser vos commandes.",
        "Gérer votre compte et votre équipe, notamment l'envoi des emails d'invitation.",
        "Assurer la sécurité du service et corriger les erreurs.",
      ],
      paragraphs: [
        "Nous ne vendons pas vos données ni celles de vos acheteurs, nous ne les utilisons pas pour de la publicité et nous n'utilisons aucun traceur publicitaire.",
      ],
    },
    {
      title: "3. Avec qui nous les partageons",
      items: [
        "Les places de marché que vous connectez : nous leur envoyons les informations nécessaires à vos annonces (titre, description, prix, stock, photos) et lisons vos commandes, dans la limite des droits que vous avez accordés.",
        "Aucun autre tiers, sauf obligation légale. OmniList est hébergé sur nos propres serveurs, et les emails partent de notre propre serveur de messagerie.",
      ],
    },
    {
      title: "4. Données des places de marché",
      paragraphs: [
        "Les données obtenues via les API (eBay, Etsy et autres) servent uniquement à faire fonctionner votre compte OmniList. Lorsqu'eBay nous notifie la fermeture ou la suppression d'un compte (Marketplace Account Deletion), nous effaçons le nom et l'identifiant de l'acheteur concerné dans vos commandes. S'il s'agit de votre compte vendeur, nous supprimons la connexion et ses jetons.",
        "Vous pouvez à tout moment retirer l'accès d'OmniList depuis les réglages de la place de marché concernée.",
      ],
    },
    {
      title: "5. Cookies",
      paragraphs: [
        "Nous utilisons seulement deux cookies, nécessaires au fonctionnement : le cookie de session (rester connecté) et le cookie de langue (français ou anglais). Aucun cookie de mesure d'audience ou de publicité.",
      ],
    },
    {
      title: "6. Durée de conservation",
      paragraphs: [
        "Les données de votre compte sont conservées tant que votre compte est actif. Sur demande de suppression, nous effaçons votre compte et les données de votre boutique sous 30 jours, sauf ce que la loi nous oblige à garder. Les sauvegardes de la base sont conservées 14 jours au plus.",
      ],
    },
    {
      title: "7. Sécurité",
      paragraphs: [
        "Les échanges passent en HTTPS. Les mots de passe sont hachés, les jetons des places de marché sont chiffrés, et les photos ne sont accessibles qu'aux membres de votre boutique connectés, ou aux places de marché par des liens signés à durée limitée.",
      ],
    },
    {
      title: "8. Vos droits",
      paragraphs: [
        `Vous pouvez demander l'accès à vos données, leur correction, leur suppression ou leur export en écrivant à ${PRIVACY_CONTACT}. Nous répondons sous 30 jours. Les résidents de Californie disposent des droits prévus par le CCPA : nous ne vendons ni ne partageons de données personnelles au sens de cette loi.`,
        "Si vous êtes l'acheteur d'un vendeur qui utilise OmniList, vous pouvez aussi vous adresser directement à ce vendeur ou à la place de marché sur laquelle vous avez acheté.",
      ],
    },
    {
      title: "9. Enfants",
      paragraphs: ["OmniList est un outil pour les vendeurs professionnels et ne s'adresse pas aux moins de 16 ans."],
    },
    {
      title: "10. Modifications et contact",
      paragraphs: [
        `Nous pouvons mettre à jour cette politique ; la date en haut de la page indique la dernière version. Pour toute question : ${PRIVACY_CONTACT}.`,
      ],
    },
  ],
};

const en: PrivacyContent = {
  title: "Privacy Policy",
  updated: "Last updated:",
  intro:
    "OmniList (omnilist.1handbiz.com), operated by 1HandBiz, helps sellers list their products and sync inventory and orders across several marketplaces. This page explains what data we process, why, and what your rights are.",
  sections: [
    {
      title: "1. Data we collect",
      items: [
        "Account: name, email address, password (stored only as a scrypt hash) and store name.",
        "Team: email addresses of the members you invite and their role.",
        "Catalog: products, variants, prices, inventory and photos you add.",
        "Channel connections: access tokens issued by the marketplaces (eBay, Etsy, Depop, Shopify, WooCommerce…) after your consent, encrypted with AES-256-GCM, plus your shop or seller account identifier.",
        "Orders imported from your channels: order number, items, amounts, status, buyer name and the buyer's marketplace identifier. We do not store buyers' postal addresses or payment details.",
        "Technical data: server logs (IP address, date, requested page) kept for security and troubleshooting.",
      ],
    },
    {
      title: "2. How we use it",
      items: [
        "To provide the service: publish and update your listings, sync inventory across your channels, prevent overselling and bring your orders together.",
        "To manage your account and team, including sending invitation emails.",
        "To keep the service secure and fix errors.",
      ],
      paragraphs: [
        "We do not sell your data or your buyers' data, we do not use it for advertising, and we use no advertising trackers.",
      ],
    },
    {
      title: "3. Who we share it with",
      items: [
        "The marketplaces you connect: we send them what your listings need (title, description, price, inventory, photos) and read your orders, within the permissions you granted.",
        "No other third parties, except where required by law. OmniList runs on our own servers, and emails are sent from our own mail server.",
      ],
    },
    {
      title: "4. Marketplace data",
      paragraphs: [
        "Data obtained through marketplace APIs (eBay, Etsy and others) is used only to operate your OmniList account. When eBay notifies us that an account was closed or deleted (Marketplace Account Deletion), we erase that buyer's name and identifier from your orders; if it is your seller account, we delete the connection and its tokens.",
        "You can revoke OmniList's access at any time from the settings of the marketplace concerned.",
      ],
    },
    {
      title: "5. Cookies",
      paragraphs: [
        "We use only two cookies, both required for the service: the session cookie (to keep you signed in) and the language cookie (French or English). No analytics or advertising cookies.",
      ],
    },
    {
      title: "6. Retention",
      paragraphs: [
        "Account data is kept while your account is active. When you ask for deletion, we erase your account and your store data within 30 days, except what the law requires us to keep. Database backups are kept for at most 14 days.",
      ],
    },
    {
      title: "7. Security",
      paragraphs: [
        "All traffic uses HTTPS. Passwords are hashed, marketplace tokens are encrypted, and photos are only available to signed-in members of your store, or to marketplaces through signed, time-limited links.",
      ],
    },
    {
      title: "8. Your rights",
      paragraphs: [
        `You can ask to access, correct, delete or export your data by writing to ${PRIVACY_CONTACT}. We reply within 30 days. California residents have the rights provided by the CCPA: we do not sell or share personal information as defined by that law.`,
        "If you bought from a seller who uses OmniList, you can also contact that seller or the marketplace where you made the purchase.",
      ],
    },
    {
      title: "9. Children",
      paragraphs: ["OmniList is a tool for business sellers and is not intended for anyone under 16."],
    },
    {
      title: "10. Changes and contact",
      paragraphs: [
        `We may update this policy; the date at the top of the page shows the latest version. Questions: ${PRIVACY_CONTACT}.`,
      ],
    },
  ],
};

export const PRIVACY: Record<Locale, PrivacyContent> = { fr, en };
