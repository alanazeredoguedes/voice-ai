# Áudio do "Testar desempenho"

O áudio desta pasta é montado a partir de uma base pública de fala com o texto exato, sob a licença
**Creative Commons Attribution 4.0 (CC BY 4.0)**:

- **fleurs.ogg / fleurs.json**: FLEURS, pt_br, split *validation*.
  Alexis Conneau et al. "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech",
  2022. Google. https://huggingface.co/datasets/google/fleurs

Modificações: frases selecionadas (uma gravação por frase), unidas com pausas de 0,5 s e recodificadas
em Opus mono 16 kHz. Gerado por `tools/build_benchmark_audio.py`.
