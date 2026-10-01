'use strict';

// Replaces all projects in the configured store (MongoDB if MONGODB_URI is set
// in the environment or .env.local, otherwise data/projects.json).
//   npm run seed    -> 12 demo teams
//   npm run reset   -> empty database
//   npm run import  -> copy data/projects.json into the configured store
// When using the JSON file, stop the local server first.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
} catch { /* optional */ }

const { getStore } = require('../lib/store');

const samples = [
  ['Pixel Pioneers', 'Campus Event Hub', 'Next.js, Tailwind, Supabase', ['Aarav Mehta', 'Diya Nair', 'Kabir Shah', 'Meera Iyer'], 9.4],
  ['Byte Brigade', 'StudySync Planner', 'React, Vite, Firebase', ['Riya Sharma', 'Arjun Patel', 'Sneha Reddy'], 8.7],
  ['Neon Ninjas', 'Portfolio Forge', 'Astro, MDX, Framer Motion', ['Ishaan Gupta', 'Ananya Rao', 'Vihaan Joshi', 'Tara Menon'], 7.9],
  ['Cloud Nine', 'WeatherWise', 'Vue 3, OpenWeather API, Pinia', ['Rohan Das', 'Kavya Pillai', 'Aditya Kulkarni'], 6.5],
  ['Lambda Legends', 'CodeQuest Arena', 'Next.js, Prisma, PostgreSQL', ['Nikhil Verma', 'Pooja Bhat', 'Siddharth Rao', 'Lakshmi Krishnan'], 9.1],
  ['Syntax Squad', 'Recipe Radar', 'HTML, CSS, Vanilla JS', ['Harsh Agarwal', 'Nisha Jain', 'Varun Sinha'], 4.2],
  ['Bit Busters', 'Expense Tracker Lite', 'React, Chart.js', ['Manav Kapoor', 'Ritika Ghosh'], 2.6],
  ['Quantum Quokkas', 'Library Lens', 'SvelteKit, SQLite', ['Yash Thakur', 'Simran Kaur', 'Dev Malhotra', 'Aisha Khan'], 7.2],
  ['Code Crafters', 'FitTrack Journal', 'React Native Web, Expo', ['Aryan Mishra', 'Neha Choudhary', 'Kunal Bose'], 5.8],
  ['Stack Sprinters', 'Alumni Connect', 'Next.js, Clerk, MongoDB', ['Pranav Hegde', 'Shreya Saxena', 'Om Prakash'], null],
  ['Dev Dynamos', 'Green Commute', 'Remix, Mapbox, Tailwind', ['Tanvi Desai', 'Rahul Nambiar', 'Zoya Ahmed', 'Karan Bajaj'], null],
  ['Async Avengers', 'Hostel Helpdesk', 'Express, EJS, MongoDB', ['Gaurav Pandey', 'Ira Banerjee'], null],
];

const notes = {
  excellent: 'Polished, responsive UI and thorough README. Great commit hygiene.',
  good: 'Solid core features. Consider improving mobile layout and documenting setup steps.',
  weak: 'Deployment intermittently fails; README missing setup steps.',
};

function demoProjects() {
  const start = Date.now() - samples.length * 5 * 60 * 60 * 1000;
  return samples.map(([teamName, title, techStack, members, score], i) => {
    const slug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const created = new Date(start + i * 5 * 60 * 60 * 1000 + Math.round(Math.random() * 3.6e6)).toISOString();
    return {
      id: crypto.randomUUID(),
      createdAt: created,
      updatedAt: created,
      teamName,
      title,
      members,
      techStack,
      vercelUrl: `https://${slug}-mdc.vercel.app/`,
      githubUrl: `https://github.com/mdc-demo/${slug}`,
      score,
      reviewerNotes: score === null ? '' : score >= 9 ? notes.excellent : score >= 5 ? notes.good : notes.weak,
      status: score === null ? 'pending' : 'graded',
      ...(score === null ? {} : { gradedAt: created }),
    };
  });
}

async function main() {
  const mode = process.argv.includes('--empty') ? 'empty' : process.argv.includes('--import') ? 'import' : 'demo';
  const store = getStore();
  let projects = [];

  if (mode === 'demo') projects = demoProjects();
  if (mode === 'import') {
    if (store.kind !== 'mongodb') throw new Error('Set MONGODB_URI (e.g. in .env.local) to import into MongoDB.');
    projects = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'projects.json'), 'utf8'));
  }

  await store.replaceAll(projects);
  const target = store.kind === 'mongodb' ? 'MongoDB' : 'data/projects.json';
  console.log(mode === 'empty' ? `Cleared all projects in ${target}.` : `Wrote ${projects.length} projects to ${target}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
