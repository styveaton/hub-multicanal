"use client";

import { AlertTriangle, CheckCircle2, Clock, ExternalLink, MinusCircle } from "lucide-react";
import Link from "next/link";
import type { Channel } from "@hub/shared";
import { useI18n } from "../../i18n/I18nProvider";
import type { Listing } from "../../lib/api";

const STATUS_ICON = { PENDING: Clock, LISTED: CheckCircle2, ERROR: AlertTriangle, REMOVED: MinusCircle } as const;

/** État des annonces d'un canal branché (une par SKU) et bouton de publication. */
export function ListingCard({
  channel,
  label,
  listings,
  pending,
  canPublish,
  notConnected,
  onPublish,
}: {
  channel: Channel;
  label: string;
  listings: Listing[];
  pending: boolean;
  canPublish: boolean;
  notConnected: boolean;
  onPublish: () => void;
}) {
  const { t } = useI18n();
  const l = t.channel.listing;
  // Textes propres au canal d'abord (ex. Depop : rupture = « marquée vendue »), puis textes communs.
  const own =
    channel === "DEPOP" ? t.channel.depop.errorCodes : channel === "EBAY" ? t.channel.ebay.errorCodes : channel === "ETSY" ? t.channel.etsy.errorCodes : {};
  const errorCodes: Record<string, string> = { ...l.errorCodes, ...own };
  const live = listings.some((x) => x.status === "LISTED" || x.status === "PENDING");

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>{l.title(label)}</h2>
          <p className="muted">{l.hint}</p>
        </div>
        <button type="button" className="btn" onClick={onPublish} disabled={pending || !canPublish}>
          {pending ? l.publishing : live ? l.update(label) : l.publish(label)}
        </button>
      </div>

      {notConnected && (
        <p className="note note--warn">
          <AlertTriangle size={16} aria-hidden /> {l.notConnected(label)} <Link href="/channels">{l.goToChannels}</Link>
        </p>
      )}

      {listings.length === 0 ? (
        <p className="empty">{l.none(label)}</p>
      ) : (
        <ul className="listing-status">
          {listings.map((item) => {
            const Icon = STATUS_ICON[item.status];
            const reason = item.errorCode ? (errorCodes[item.errorCode] ?? item.errorMessage ?? item.errorCode) : null;
            return (
              <li key={item.sku} className={`listing-status--${item.status.toLowerCase()}`}>
                <Icon size={16} aria-hidden />
                <span className="listing-sku">{item.sku}</span>
                <span className="listing-state">
                  {l.status[item.status]}
                  {reason && <small> · {reason}</small>}
                </span>
                {item.status === "LISTED" && item.externalUrl && (
                  <a href={item.externalUrl} target="_blank" rel="noreferrer" className="listing-link">
                    {l.view(label)} <ExternalLink size={14} aria-hidden />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
