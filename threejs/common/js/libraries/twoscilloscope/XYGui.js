/*
+ + +   three.twoscilloscope   + + +

In place of ofxGui: XYParameterGroups in a lil-gui panel (lil-gui comes
with three.js, in addons/libs/lil-gui.module.min.js). Each number gets a
slider, each bool a checkbox, and each group a folder.

    import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

    const gui = new XYGui(new GUI({ title: 'effects' }), transformer.effects.parameters);
    gui.add(renderer.parameters);
    gui.getGroup('low pass').close();

Like gui.setup(group) in ofxGui, the constructor puts the group's settings
straight into the panel, its groups as folders, and add() adds another
group as a folder. The controls listen, so settings changed in code move
them too. It only uses addFolder() and add(), so dat.gui works as well.
*/

export class XYGui {

    constructor(gui, group) {
        this.gui = gui;
        this.folders = new Map();
        if (group) this.addItems(gui, group);
    }

    // Add a group of settings as a folder. Returns the folder.
    add(group, parent = this.gui) {
        const folder = parent.addFolder(group.getName());
        if (!this.folders.has(group.getName())) this.folders.set(group.getName(), folder);
        this.addItems(folder, group);
        return folder;
    }

    addItems(target, group) {
        for (const item of group.items) {
            if (item.type === 'group') {
                this.add(item.group, target);
            } else if (item.type === 'bool') {
                target.add(item.object, item.key).name(item.label).listen();
            } else {
                const controller = target.add(item.object, item.key, item.min, item.max).name(item.label).listen();
                if (item.type === 'int') controller.step(1);
            }
        }
    }

    // a group's folder, by name: open() and close() it
    getGroup(name) {
        const folder = this.folders.get(name);
        if (folder) return folder;
        console.warn('XYGui: no group called ' + name);
        return { open() {}, close() {} };
    }

}
