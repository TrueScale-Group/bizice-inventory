/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        prompt: ['Prompt', 'sans-serif'],
        sarabun: ['Sarabun', 'sans-serif'],
      },
      colors: {
        red: {
          brand: '#E31E24',
          dark: '#B01519',
          light: '#FFF0F0',
          light2: '#FFE4E5',
        },
      },
    },
  },
  plugins: [],
}
