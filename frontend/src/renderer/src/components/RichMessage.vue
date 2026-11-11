<script setup lang="ts">
/**
 * Corpo de uma resposta da IA: parágrafos, títulos, listas, tabelas e as imagens no lugar onde a IA
 * colocou. Cada trecho de texto é um <span data-o> com a posição no texto falado (utils/textMap.ts
 * usa isso para o destaque da fala, a seleção e o "parou em").
 */
import { computed } from 'vue'
import type { MediaGroup } from '../types'
import { buildDoc, type Run } from '../utils/richText'
import MediaGrid from './MediaGrid.vue'
import MediaBlock from './MediaBlock.vue'

const props = defineProps<{ content: string; media?: MediaGroup[]; streaming?: boolean; messageId?: number }>()

const doc = computed(() => buildDoc(props.content, !!props.streaming))

const groupById = computed(() => new Map((props.media ?? []).map((g) => [g.group_id, g])))

/** Grupos que não estão no meio do texto (respostas antigas): ficam no fim, como antes. */
const trailing = computed(() => {
  const inline = new Set(doc.value.blocks.flatMap((b) => (b.type === 'media' ? [b.id] : [])))
  return (props.media ?? []).filter((g) => !inline.has(g.group_id))
})

function runClass(r: Run): string[] {
  const c: string[] = []
  if (r.bold) c.push('font-semibold text-slate-50')
  if (r.italic) c.push('italic')
  if (r.code) c.push('rich-code')
  return c
}
</script>

<template>
  <div class="rich">
    <template v-for="(b, bi) in doc.blocks" :key="bi">
      <p v-if="b.type === 'p'" class="rich-p">
        <span v-for="(r, ri) in b.runs" :key="ri" :data-o="r.o" :class="runClass(r)">{{ r.text }}</span>
      </p>
      <p v-else-if="b.type === 'h'" :class="['rich-h', b.level <= 2 ? 'rich-h2' : 'rich-h3']">
        <span v-for="(r, ri) in b.runs" :key="ri" :data-o="r.o" :class="runClass(r)">{{ r.text }}</span>
      </p>
      <component :is="b.ordered ? 'ol' : 'ul'" v-else-if="b.type === 'list'" class="rich-list">
        <li
          v-for="(it, ii) in b.items"
          :key="ii"
          class="rich-li"
          :style="it.indent ? { marginLeft: `${Math.min(it.indent, 8) * 0.5}em` } : undefined"
        >
          <span v-if="it.marker" :data-o="it.marker.o" class="rich-num">{{ it.marker.text }}</span>
          <span v-else class="rich-bullet" aria-hidden="true" />
          <span class="min-w-0"><span v-for="(r, ri) in it.runs" :key="ri" :data-o="r.o" :class="runClass(r)">{{ r.text }}</span></span>
        </li>
      </component>
      <div v-else-if="b.type === 'table'" class="rich-table-wrap">
        <table class="rich-table">
          <thead v-if="b.header">
            <tr>
              <th v-for="(cell, ci) in b.header" :key="ci">
                <span v-for="(r, ri) in cell" :key="ri" :data-o="r.o" :class="runClass(r)">{{ r.text }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rj) in b.rows" :key="rj">
              <td v-for="(cell, ci) in row" :key="ci">
                <span v-for="(r, ri) in cell" :key="ri" :data-o="r.o" :class="runClass(r)">{{ r.text }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <template v-else-if="b.type === 'media'">
        <template v-if="groupById.get(b.id)">
          <!-- escolhidas pela IA depois de ver a busca: layout de destaque -->
          <MediaBlock
            v-if="groupById.get(b.id)!.picked"
            :group="groupById.get(b.id)!"
            :message-id="streaming ? undefined : messageId"
            class="rich-media"
          />
          <MediaGrid v-else :groups="[groupById.get(b.id)!]" class="rich-media" />
        </template>
      </template>
      <p v-else-if="b.type === 'raw'" class="rich-p text-slate-400">{{ b.text }}</p>
    </template>
    <MediaGrid v-if="trailing.length" :groups="trailing" class="rich-media" />
  </div>
</template>

<style scoped>
.rich > * + * {
  margin-top: 0.7em;
}
.rich-h {
  font-weight: 600;
  color: rgb(241 245 249);
  line-height: 1.35;
}
.rich > * + .rich-h {
  margin-top: 1.25em;
}
.rich-h2 {
  font-size: 1.15em;
}
.rich-h3 {
  font-size: 1.05em;
}
.rich-list {
  display: flex;
  flex-direction: column;
  gap: 0.3em;
  padding-left: 0.25em;
}
.rich-li {
  display: flex;
  gap: 0.5em;
  align-items: baseline;
}
.rich-num {
  flex-shrink: 0;
  min-width: 1.4em;
  font-weight: 600;
  color: rgb(203 213 225);
  font-variant-numeric: tabular-nums;
}
.rich-bullet {
  flex-shrink: 0;
  width: 0.36em;
  height: 0.36em;
  margin: 0 0.45em 0 0.35em;
  border-radius: 9999px;
  background: rgb(148 163 184);
  transform: translateY(-0.15em);
}
.rich-code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.9em;
  padding: 0.1em 0.35em;
  border-radius: 0.35em;
  background: rgb(30 41 59);
  border: 1px solid rgb(51 65 85 / 0.6);
}
.rich-table-wrap {
  overflow-x: auto;
}
.rich-table {
  border-collapse: collapse;
  font-size: 0.95em;
  min-width: 50%;
}
.rich-table th,
.rich-table td {
  border: 1px solid rgb(51 65 85 / 0.7);
  padding: 0.4em 0.75em;
  text-align: left;
  vertical-align: top;
}
.rich-table th {
  background: rgb(30 41 59 / 0.7);
  font-weight: 600;
  color: rgb(241 245 249);
}
.rich-media {
  margin-top: 0.9em;
}
</style>
