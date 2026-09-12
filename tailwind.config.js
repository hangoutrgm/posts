/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./*.html",
    "./js/**/*.{js,html}",
    "./config/**/*.{html,js}",
    "./reels/**/*.{html,js}",
    "./treasury/**/*.{html,js}",
    "./chat/**/*.{html,js}"
  ],
  theme: {
    extend: {
      colors: {
        dark: '#0f172a',
        darker: '#0b1121',
        card: '#1e293b',
        accent: '#6366f1',
      },
      fontFamily: {
        sans: ['Inter', '"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
