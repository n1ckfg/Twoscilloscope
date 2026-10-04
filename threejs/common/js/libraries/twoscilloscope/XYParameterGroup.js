/*
+ + +   three.twoscilloscope   + + +

XYParameterGroup: settings for a panel, in place of ofParameterGroup.

ofParameters become plain properties here, so effect.cutoff = 1500 works
the way lowPass->cutoff = 1500 did. A group lists which properties are
settings, with a label and a range, and can hold other groups, which is
all XYGui needs to build lil-gui folders for them.
*/

export class XYParameterGroup {

    constructor(name = '') {
        this.name = name;
        this.items = [];
    }

    getName() {
        return this.name;
    }

    // add(object, key, label, min, max, type): object[key] is a setting.
    // type is 'float', 'int' or 'bool' (the default follows the value).
    // add(group) adds a group of settings.
    add(object, key, label = key, min = 0, max = 1, type) {
        if (object instanceof XYParameterGroup) {
            this.items.push({ type: 'group', group: object });
            return this;
        }
        if (type === undefined) type = typeof object[key] === 'boolean' ? 'bool' : 'float';
        this.items.push({ type, object, key, label, min, max });
        return this;
    }

    // a setting by its label
    get(label) {
        return this.items.find((item) => item.label === label);
    }

    clear() {
        this.items = [];
        return this;
    }

}
