// A random, friendly username. No real names anywhere in the app.
const A = ['Crimpy', 'Chalky', 'Slabby', 'Dyno', 'Juggy', 'Pumped', 'Sendy', 'Smeary', 'Pinchy', 'Flashy', 'Steady', 'Springy', 'Sloper', 'Campus', 'Gnarly', 'Sunny', 'Zippy', 'Mellow']
const B = ['Gecko', 'Lemur', 'Ibex', 'Squirrel', 'Marmot', 'Falcon', 'Otter', 'Koala', 'Panda', 'Lynx', 'Sloth', 'Monkey', 'Goat', 'Puffin', 'Badger', 'Fox', 'Owl', 'Newt']
export function randomUsername() {
  const pick = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)]
  return `${pick(A)}${pick(B)}${10 + Math.floor(Math.random() * 90)}`
}
