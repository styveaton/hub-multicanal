"use client";

import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";

export interface VariantRow {
  key: string; // clé React stable
  id?: string;
  sku: string;
  values: string[]; // une valeur par option, dans l'ordre de `options`
  price: string; // saisie libre, ex. « 19.99 »
  quantity: string;
}

let counter = 0;
export const newVariantRow = (optionCount: number): VariantRow => ({
  key: `v${++counter}`,
  sku: "",
  values: Array(optionCount).fill(""),
  price: "",
  quantity: "1",
});

/**
 * Variantes (US4) : 1 à 3 options (ex. Taille, Couleur), puis une ligne par variante
 * avec ses valeurs, son SKU, son prix et sa quantité.
 */
export function VariantsEditor({
  options,
  rows,
  onOptionsChange,
  onRowsChange,
}: {
  options: string[];
  rows: VariantRow[];
  onOptionsChange: (options: string[]) => void;
  onRowsChange: (rows: VariantRow[]) => void;
}) {
  const v = useI18n().t.variants;
  const update = (key: string, patch: Partial<VariantRow>) => onRowsChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function addOption() {
    onOptionsChange([...options, ""]);
    onRowsChange(rows.map((r) => ({ ...r, values: [...options.map((_, j) => r.values[j] ?? ""), ""] })));
  }

  function removeOption(index: number) {
    onOptionsChange(options.filter((_, i) => i !== index));
    onRowsChange(rows.map((r) => ({ ...r, values: r.values.filter((_, i) => i !== index) })));
  }

  return (
    <div className="variants">
      <div className="variant-options">
        {options.map((name, i) => (
          <label key={i} className="field">
            {v.option(i + 1)}
            <span className="input-group">
              <input
                className="input"
                value={name}
                placeholder={v.optionPlaceholders[i]}
                onChange={(e) => onOptionsChange(options.map((o, j) => (j === i ? e.target.value : o)))}
                required
              />
              {options.length > 1 && (
                <button type="button" className="icon-btn icon-btn--light" onClick={() => removeOption(i)} aria-label={v.removeOption(i + 1)}>
                  <Trash2 size={16} />
                </button>
              )}
            </span>
          </label>
        ))}
        {options.length < 3 && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={addOption}>
            <Plus size={16} aria-hidden /> {v.addOption}
          </button>
        )}
      </div>

      <div className="table-scroll">
        <table className="variant-table">
          <thead>
            <tr>
              {options.map((name, i) => (
                <th key={i} scope="col">
                  {name || v.option(i + 1)}
                </th>
              ))}
              <th scope="col">SKU</th>
              <th scope="col">{v.price}</th>
              <th scope="col">{v.quantity}</th>
              <th scope="col">
                <span className="sr-only">{v.actions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={row.key}>
                {options.map((name, i) => (
                  <td key={i}>
                    <input
                      className="input input--sm"
                      value={row.values[i] ?? ""}
                      aria-label={v.cell(name || v.option(i + 1), r + 1)}
                      // Reconstruit une valeur par option, même si la ligne en avait moins.
                      onChange={(e) => update(row.key, { values: options.map((_, j) => (j === i ? e.target.value : (row.values[j] ?? ""))) })}
                      required
                    />
                  </td>
                ))}
                <td>
                  <input
                    className="input input--sm"
                    value={row.sku}
                    aria-label={v.cell("SKU", r + 1)}
                    onChange={(e) => update(row.key, { sku: e.target.value })}
                    required
                  />
                </td>
                <td>
                  <input
                    className="input input--sm"
                    inputMode="decimal"
                    value={row.price}
                    placeholder="0.00"
                    aria-label={v.cell(v.price, r + 1)}
                    onChange={(e) => update(row.key, { price: e.target.value })}
                    required
                  />
                </td>
                <td>
                  <input
                    className="input input--sm"
                    type="number"
                    min={0}
                    step={1}
                    value={row.quantity}
                    aria-label={v.cell(v.quantity, r + 1)}
                    onChange={(e) => update(row.key, { quantity: e.target.value })}
                    // Variante existante : son stock suit les ventes, il se corrige sur la page Stock.
                    disabled={!!row.id}
                    title={row.id ? v.stockLocked : undefined}
                    required
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="icon-btn icon-btn--light"
                    onClick={() => onRowsChange(rows.filter((x) => x.key !== row.key))}
                    disabled={rows.length === 1}
                    aria-label={v.remove(r + 1)}
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.some((row) => row.id) && <p className="field-hint">{v.stockHint}</p>}
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => onRowsChange([...rows, newVariantRow(options.length)])}>
        <Plus size={16} aria-hidden /> {v.add}
      </button>
    </div>
  );
}
